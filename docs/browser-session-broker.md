# Browser Session Broker

The browser broker prevents concurrent agents from sharing a mutable browser
profile or editing the same remote account or record at the same time.

## Routing contract

| Work | Backend | Isolation |
|---|---|---|
| Public, ordinary browsing | Playwright CLI | Unique named session and persistent profile per lease, bounded by a configurable ceiling |
| Authenticated or sensitive browsing | Brave + Interceptor | One of a configurable number of exclusively leased, non-personal Brave profiles |

Authentication is a routing boundary, not a convenience flag. Authenticated
and sensitive leases fail unless the caller names an account or resource lock.
The Brave slots never point at Brave's standard user-data root and never
reuse the Default personal profile.

## State and security

The default broker root is:

```text
~/Library/Application Support/Codex Browser Broker
```

It is created with user-only permissions. Lease acquisition uses atomic lock
directories. A lease has an unguessable capability token; heartbeat, environment
discovery, and release require that token. `status` intentionally redacts it.

Locks have three levels:

- `slot:brave-N` prevents two agents from controlling the same Brave instance.
- `account:<domain>:<account>` prevents concurrent edits to one remote account,
  even when the requests would otherwise use different browser backends.
- `resource:<resource>` prevents concurrent edits to a specific form, record,
  draft, cart, or case.

Leases older than the configured TTL are reported as stale, but the broker never
reclaims them automatically. This avoids taking a browser away from a slow or
temporarily suspended agent. A busy request is written to the queue and exits
with status 75; the caller can inspect `status` and retry after the owner releases.
If an owning session is gone, an operator can reclaim a stale lease only by
supplying its exact ID twice: `reclaim --lease ID --confirm-stale ID`. The command
refuses leases that have not crossed the TTL.

The default capacity is six ordinary Playwright sessions and two Brave slots.
Capacity can be increased without replacing existing profiles or leases:

```bash
browser-broker configure-capacity --max-playwright 6 --brave-slots 4
```

The Playwright ceiling is enforced with atomic numbered capacity locks. Older
leases created before capacity locks were introduced are counted during the
migration, so upgrading cannot temporarily exceed the configured maximum.
Shrinking the Brave pool is intentionally refused because deleting or retiring
an authenticated profile is a separate destructive operation.

## Installation

From the Interceptor repository:

```bash
bash scripts/install-browser-broker.sh
bash scripts/build.sh --browser-only
bash scripts/install-browser-broker-runtime.sh
INTERCEPTOR_WS_PORT=19422 bash scripts/prepare-browser-broker-extension.sh
bash scripts/install-browser-broker-launchagent.sh
```

The installer compiles a standalone `~/.local/bin/browser-broker`, keeps a
timestamped rollback copy of an existing binary, and installs the pinned official
Playwright CLI under `~/.local/share/codex-browser-broker`. The runtime installer
places a separate Interceptor CLI, daemon, and profile guard under the broker
root. The extension copy is rewritten to use only the private port, and the user
LaunchAgent keeps that private daemon alive without restarting the system
Interceptor service.

Initialize once, pointing at the broker-specific Interceptor extension build and
guard script:

```bash
browser-broker init \
  --extension-path "$HOME/Library/Application Support/Codex Browser Broker/extension" \
  --guard-script /path/to/interceptor/scripts/profile-context-guard.sh \
  --interceptor-bin /path/to/interceptor/dist/interceptor \
  --playwright-command "$HOME/.local/share/codex-browser-broker/node_modules/.bin/playwright-cli" \
  --interceptor-temp "$HOME/Library/Application Support/Codex Browser Broker/runtime/interceptor" \
  --ws-port 19422
```

Prepare each newly added clean Brave profile after the broker-specific daemon and extension
have been built for the configured port:

```bash
browser-broker prepare-slot --slot brave-1
browser-broker prepare-slot --slot brave-2
browser-broker prepare-slot --slot brave-3
browser-broker prepare-slot --slot brave-4
```

Preparation opens a background Brave process with a unique `--user-data-dir`,
loads only the broker extension, discovers its stable Interceptor context and
instance IDs, and writes a slot-specific guard file. It does not copy cookies,
passwords, history, or profile data from any personal browser.

## Agent use

Public work:

```bash
browser-broker acquire --task news-research --sensitivity ordinary
browser-broker env --lease LEASE_ID --token LEASE_TOKEN
```

The returned environment includes `PLAYWRIGHT_CLI_SESSION` and
`PLAYWRIGHT_CLI_PROFILE`. The first open for that lease should be persistent:

```bash
playwright-cli open https://example.com --persistent --profile="$PLAYWRIGHT_CLI_PROFILE"
```

Sensitive portal work:

```bash
browser-broker acquire \
  --task workday-questionnaire \
  --sensitivity sensitive \
  --domain workday.mdlcentrality.com \
  --account greg \
  --resource mobley-workday-questionnaire
```

The returned environment identifies exactly one guard preferences file. Every
Interceptor command for that lease must run through the profile guard. Heartbeat
long-running work and always release the exact lease when finished:

```bash
browser-broker heartbeat --lease LEASE_ID --token LEASE_TOKEN
browser-broker release --lease LEASE_ID --token LEASE_TOKEN
```

When an acquisition is blocked, repeated retries replace the prior matching
queue entry instead of creating duplicates. A successful retry removes the
matching queue entry automatically. The queue remains an audit/retry record,
not a background dispatcher; a suspended caller must still retry acquisition.

## Operational boundary

The broker prevents local profile collisions and declared remote-record
collisions. It cannot prevent an agent that bypasses the broker from using a
browser directly. Agent instructions therefore need to make broker acquisition
mandatory before browser work. Human use of the same remote form can still
conflict with an agent and should be represented by a manual lease when needed.

Do not put passwords, session cookies, portal links, or one-time codes in task,
account, resource, or queue labels.
