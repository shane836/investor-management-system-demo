import { FIRM, IR_EMAIL } from "@/lib/util";
import { sendMagicLink, signOut } from "./actions";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const profileIssue = sp.error === "no-profile" || sp.error === "profile-unavailable";
  const errorMessage = sp.error === "no-profile"
    ? "You are signed in, but your portal profile is missing. Ask the sponsor to repair your account; requesting another sign-in link will not fix it."
    : sp.error === "profile-unavailable"
      ? "You are signed in, but the portal could not read your profile. Ask the sponsor to check database permissions and migrations."
      : sp.error;
  return (
    <main className="shell">
      <div className="login card">
        <h1>{FIRM}</h1>
        <p className="muted">Investor portal</p>
        {errorMessage && <div className="notice bad" role="alert">{errorMessage}</div>}
        {profileIssue ? (
          <div className="stack">
            <a className="btn" href="/">Check account again</a>
            <form action={signOut}><button type="submit" className="secondary">Sign out and use another account</button></form>
          </div>
        ) : sp.sent ? (
          <div className="notice ok">
            If that email is on our investor list, a sign-in link is on its way. It expires in 1 hour.
          </div>
        ) : (
          <form action={sendMagicLink}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <button type="submit">Email me a sign-in link</button>
          </form>
        )}
        {IR_EMAIL && (
          <p className="small muted" style={{ marginTop: 20 }}>
            Not set up yet? Contact <a href={`mailto:${IR_EMAIL}`}>{IR_EMAIL}</a>.
          </p>
        )}
      </div>
    </main>
  );
}
