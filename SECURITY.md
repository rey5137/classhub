# Security policy

## Supported versions

Class Hub 1.x receives security fixes. The project is a self-hosted application; each deployment is run by its own
admins, so a fix reaches a site when its admin updates the code.

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a vulnerability.

Report it privately through GitHub security advisories: open the repository's **Security** tab and choose
**Report a vulnerability**. That creates a private advisory only the maintainers can see. If GitHub advisories are
not available, use the private contact address in the repository profile.

Please include:

- the affected version or commit;
- what an attacker can do, and the steps to reproduce it;
- whether the report involves real member data (do not include that data itself).

The maintainers will acknowledge the report, investigate, and coordinate a fix and a disclosure date with you. Please
give them time to release a fix before telling anyone else.

## Scope

Reports are especially welcome for these areas, which the design treats as security boundaries:

- **Identity and Access:** forged or missing Access JWTs, the membership check, invites, suspension, the setup lock,
  the dev identity in a production build, session and cookie handling.
- **Media:** access to photos or avatars outside their visibility, public R2 access, upload reservations and quota.
- **Chat:** the WebSocket handshake, authorization of messages and history, message deletion, chat archives.
- **Backups:** encryption, the account guard, secret scanning, restore into a live site, deletion re-application.

Out of scope: vulnerabilities in Cloudflare, Google or a member's browser; a site whose admin has made the bucket
public or turned off Access; social engineering of a site's admins.

## Safe harbour

Good-faith research on a site you run, or on your own deployment, is welcome. Do not test against another person's
site without their permission, do not access or download real member data, and do not run denial-of-service tests.
