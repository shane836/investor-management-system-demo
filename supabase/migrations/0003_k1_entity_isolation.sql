-- K-1 contract: one investing entity, canonical private path, owner/GP reads.
-- Existing malformed rows/files are retained and quarantined from LP reads.
begin;

-- Shared path contract for metadata writes, storage writes and read isolation.
create function is_entity_k1_path(object_name text, investing_entity_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from investing_entities e
    where e.id = investing_entity_id
      and split_part(object_name, '/', 1) = e.owner_id::text
      and split_part(object_name, '/', 2) = e.id::text
      and split_part(object_name, '/', 3) = 'k1'
      and split_part(object_name, '/', 4) <> ''
      and array_length(string_to_array(object_name, '/'), 1) = 4
  );
$$;

create function documents_k1_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'k1' and not is_entity_k1_path(new.file_path, new.entity_id) then
    raise exception 'K-1 requires an investing entity and its owner/entity/k1/filename private path';
  end if;
  return new;
end $$;
create trigger documents_k1_guard before insert or update on documents
  for each row execute function documents_k1_guard();

-- A restrictive policy also protects malformed rows predating this migration.
create policy documents_k1_read on documents as restrictive
  for select to authenticated using (
    is_gp() or kind <> 'k1'
    or (owns_entity(entity_id) and is_entity_k1_path(file_path, entity_id))
  );

create function storage_k1_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_k1 boolean;
begin
  v_k1 := new.bucket_id = 'portal' and (
    split_part(new.name, '/', 3) = 'k1'
    or exists (select 1 from documents d where d.kind = 'k1' and d.file_path = new.name)
  );
  if tg_op = 'UPDATE' then
    -- Renaming a K-1 must not turn its bytes into a shared offering document.
    v_k1 := v_k1 or (old.bucket_id = 'portal' and (
      split_part(old.name, '/', 3) = 'k1'
      or exists (select 1 from documents d where d.kind = 'k1' and d.file_path = old.name)
    ));
  end if;
  if v_k1 and (new.bucket_id <> 'portal' or not exists (
    select 1 from investing_entities e where is_entity_k1_path(new.name, e.id)
  )) then
    raise exception 'K-1 storage requires an owner/entity/k1/filename private path';
  end if;
  return new;
end $$;
create trigger storage_k1_guard before insert or update on storage.objects
  for each row execute function storage_k1_guard();

-- Security definer sees K-1 references hidden by document RLS. Otherwise an LP
-- could bypass a hidden document row by requesting its shared raw object path.
create function can_read_k1_object(object_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select (
    split_part(object_name, '/', 3) <> 'k1'
    or exists (
      select 1 from investing_entities e
      where e.owner_id = auth.uid() and is_entity_k1_path(object_name, e.id)
    )
  ) and not exists (
    select 1 from documents d
    where d.kind = 'k1' and d.file_path = object_name
      and (not owns_entity(d.entity_id) or not is_entity_k1_path(object_name, d.entity_id))
  );
$$;
create policy portal_k1_read on storage.objects as restrictive
  for select to authenticated using (
    bucket_id <> 'portal' or is_gp() or can_read_k1_object(name)
  );

commit;
