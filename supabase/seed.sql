-- 1) Sign in once with your own email (magic link), then make yourself GP:
update profiles set role = 'gp' where email = 'sponsor@example.com';

-- 2) Optional starter deal (or create it from /admin):
-- insert into deals (name, status, target_raise, min_investment, max_investors)
-- values ('Sample Storage Offering', 'draft', 2000000, 50000, 25)
-- returning id;
-- insert into deal_private (deal_id, wire_instructions) values ('<id>', 'Bank: ...');
