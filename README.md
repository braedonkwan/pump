# Pump

A desktop browser game that takes a balloon from a meadow to the stars. Each pump increases the payout and the chance of popping; cash out before the balloon pops or survive all 25 pumps to reach the Astral Crown.

Pump uses demo credits. There are no deposits or withdrawals.

[Play the demo](https://pump-demo.braedon-kwan.workers.dev/) · [Public repository](https://github.com/braedonkwan/pump)

## Run locally

Install Node.js **22.13.0 or newer** and npm. Run these commands from the repository root:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. Vite serves the client and proxies `/api/` requests to the Node server at `127.0.0.1:3001`. SQLite tables are created automatically; no separate database server is needed.

To run the compiled app locally:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:3001**. This server serves both the built client and the API.

Normal gameplay is the default. For flights with popping disabled, use `npm run dev:test`, or `npm run start:test` after building. Test mode uses a separate database and session cookie. Existing rounds retain the mode and payout curve recorded when they were created.

## How to play

- New wallets start with **$10,000** in demo credits.
- Bets range from **$0.10 to $1,000**, in **$0.10 increments**.
- Each successful pump raises the multiplier. Popping loses the stake.
- Cashing out pays the displayed amount, including the stake. Cashing out before the first pump returns the full stake.
- Surviving pump 25 automatically settles the round at **1,000×** under the current curve.
- A wallet below the minimum bet resets to **$10,000** once no flight is active. The ledger records the exact credit added.

## A reason to keep climbing

The balloon travels through eight worlds, from the meadow through clouds, crystals, storms, and celestial ruins to the Astral Crown. Milestones introduce new scenery and animated creatures, and the summit has its own celebration. The climb gives each decision a visible destination as well as a larger multiplier: cashing out secures the payout, while continuing reveals more of the world.

Music and sound effects mark inflation, popping, cashout, and the summit. Music and effects can be muted independently, and reduced motion preferences are respected.

## Pop curve and payout design

New rounds use curve version 3 in [PumpEngine.ts](src/engine/PumpEngine.ts). The design makes both the multiplier and the conditional chance of popping rise on every pump, while keeping supported payouts in whole cents and ending at exactly 1,000× on pump 25. Increasing risk makes the decision to continue progressively harder; a fixed summit gives the climb a clear endpoint.

### How the curve is constructed

The ladder is built with integer arithmetic at the minimum stake of 10 cents:

1. A shaping input starts with 96% conditional survival and decreases by 1.23 percentage points per pump. This input guides payout growth; it is not the final probability displayed to the player.
2. The first candidate payout is `ceil(0.97 * 10 / 0.96)` cents. Later candidates are `ceil(previousPayout / shapingSurvival)`. A second ceiling constraint uses the previous nominal survival ratio to prevent whole-cent payout steps from flattening or reducing the next pop risk. The larger candidate is selected.
3. Pump 25's minimum-stake payout is fixed at 10,000 cents, making the multiplier 1,000×. Earlier steps remain below that cap.
4. For each selected payout `p[n]`, the initial cumulative survival threshold is `floor(97 * 2^256 * 10 / (100 * p[n]))`. Thresholds from pump 2 onward are also bounded so conditional survival decreases by at least `80 / 1,000,000` per step. This makes conditional pop risk increase by at least 0.008 percentage points.
5. Initialization rejects a curve whose modeled RTP falls below 96.99%. Each round records its curve version so later engine changes preserve historical outcomes and proofs.

The first payout is therefore 11 cents on a 10-cent stake: **1.10×**, with an actual first-pump pop chance of **11.82%**. The shaping input's 4% first-pump risk is adjusted by the whole-cent payout constraints. Representative values from the final curve are:

| Pump attempted | Multiplier if survived | Chance of popping on that pump |
| -------------- | ---------------------- | ------------------------------ |
| 1              | 1.10×                  | 11.82%                         |
| 5              | 2.50×                  | 20.01%                         |
| 10             | 9.00×                  | 23.33%                         |
| 15             | 35.50×                 | 24.23%                         |
| 20             | 154.10×                | 27.38%                         |
| 25             | 1,000.00×              | 34.07%                         |

The chance of surviving the entire current ladder is approximately 0.097%. Probabilities in the table are rounded for display; settlement uses the integer thresholds.

### Exact RTP calculation

Let `R = 2^256`, `T[n]` be the cumulative survival threshold after pump `n`, and `b` be the stake in integer cents. For a uniform unsigned 256-bit engine input, exactly `T[n]` of the `R` possible inputs survive through pump `n`.

```text
P(survive through n) = T[n] / R
payout(b, n) = floor(b * multiplierMicros[n] / 1,000,000)
RTP(b, n) = T[n] * payout(b, n) / (R * b)
```

The nominal threshold targets 97%. Integer threshold rounding and the explicit adjustment for strictly increasing pop risk keep the actual return at or below that target. The current guarantee for played cashout points is **96.99% ≤ RTP ≤ 97%**.

[engine.test.ts](tests/engine.test.ts) checks that bound for all 25 played steps and all 10,000 supported bet amounts: 250,000 step/stake combinations. It cross-multiplies using `BigInt`:

```text
100 * T[n] * payout(b, n) <= 97 * R * b
10,000 * T[n] * payout(b, n) >= 9,699 * R * b
```

These are exact integer checks with no sampling error. The suite also checks randomness boundaries, increasing displayed risk, deterministic outcomes, and automatic settlement at the cap. Run it directly with:

```sh
node --import tsx --test tests/engine.test.ts
```

**Scope of the claim:** the proof covers normal-play pumps 1–25 and stakes in $0.10 increments. Cashing out before any pump is a full-stake refund through the cashout endpoint, giving a 100% return. It is excluded from the played-round RTP bound. This pre-pump refund and the ten-cent bet restriction are explicit differences from a literal reading of the take-home's rules. Test mode bypasses popping and is also outside the normal-play RTP claim.

### Integer money and rounding

Wallet balances, stakes, ledger deltas, and credited payouts are stored as integer cents. Multipliers use an integer scale of 1,000,000; probability thresholds and payout arithmetic use `BigInt`.

Payout division rounds down to the nearest cent. This prevents crediting more than the calculated payout and keeps rounding from pushing expected return above the curve's target. The current ten-cent stakes and selected multipliers produce whole-cent payouts without additional payout rounding; archived curves and older odd-cent stakes still use downward rounding. Probability thresholds are also rounded down to whole integers. Decimal percentages and currency strings are presentation values.

## Wallets and round integrity

A wallet belongs to an anonymous session cookie. The database stores the token's hash. Refreshing restores the wallet and current flight; clearing cookies or using another browser creates a different wallet.

The server controls outcomes and balances. Bet debits, settlements, refills, and append-only ledger entries share database transactions. Start request IDs prevent duplicate bets, and round versions reject conflicting actions. Retrying an earlier start or cashout returns the current game state without repeating its debit or payout.

Every round exposes a SHA-256 commitment to its server seed. The seed and derived pop point are revealed after settlement. Outcome derivation lives in [fairness.ts](src/server/fairness.ts), and the versioned risk and payout curves live in [PumpEngine.ts](src/engine/PumpEngine.ts).

### Abandoned rounds

An abandoned flight remains active in the database with its original stake, seed commitment, and pump count. Refreshing or returning with the same session restores it. It has no automatic expiry or settlement; the player must resume pumping or cash out before starting another flight.

This policy preserves a player's decision through a closed tab, network interruption, or server restart. It also avoids a timeout changing the outcome or cashout point without a player action. The tradeoff is retaining unfinished rounds indefinitely. The public room's inactivity timeout only releases an admission slot; it does not delete, refund, or settle the flight. A saved flight can still be cashed out while the room is full.

### Inspect fairness in the Network tab

1. Open browser developer tools, select **Network**, filter for `/api/`, and start a normal round. In the `/api/pump/start` response, record `round.id`, `round.curveVersion`, and the 64-character `round.serverSeedHash`. `round.proof` must be `null` before the first pump.
2. Pump or refresh while the flight is active. The current round must still have `proof: null`; its server seed, random value, and pop point are not included. Completed rounds in `history` can legitimately contain their own revealed proofs.
3. Cash out or pop. The settlement response includes `round.proof.serverSeed`, `randomValueHex`, and `popAtPump`. The **Seed details** dialog shows the commitment and revealed seed.
4. Hash the revealed seed as a UTF-8 hex string using SHA-256 and compare it with the recorded commitment. Recompute `SHA256("pump:v<curveVersion>:<roundId>:<serverSeed>")`, parse the resulting hex as an unsigned integer, and pass it to `getPopPoint` with the recorded curve version. The result must match the revealed pop point. [deriveOutcome](src/server/fairness.ts) implements these steps, and [fairness.test.ts](tests/fairness.test.ts) provides fixed test vectors.

The recorded curve version matters when checking older rounds. Testing rounds are labeled `testing` and intentionally override the original pop outcome; use normal mode to inspect the unmodified behavior.

## Verification

| Command                | Purpose                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm run check`        | Type-check the client, Node server, tests, and Worker.                                                        |
| `npm test`             | Run all TypeScript test suites, including Node HTTP, Vite, and isolated Worker fixtures.                      |
| `npm run test:unit`    | Run the suites excluding the Node HTTP and Vite development-server fixtures; includes Miniflare Worker tests. |
| `npm run test:browser` | Build the app and run headless Chrome/Chromium checks.                                                        |
| `npm run test:all`     | Run the TypeScript suites and browser checks.                                                                 |
| `npm run format:check` | Check formatting with Prettier.                                                                               |
| `npm run format`       | Format the repository with Prettier.                                                                          |
| `npm run deploy:check` | Build the app and dry-run the Cloudflare deployment without publishing.                                       |

Browser checks require Chrome or Chromium. The harness searches common installation paths; set `CHROME_PATH` if yours is elsewhere. For example, in PowerShell:

```powershell
$env:CHROME_PATH = 'C:\path\to\chrome.exe'
npm run test:browser
```

Tests use isolated fixtures. Browser screenshots and reports are written under the ignored `test-results/` directory.

## Local configuration

Set environment variables in the shell before launching the Node server. The startup commands do not automatically load `.env` files.

| Variable                  | Default                    | Purpose                                                                                    |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| `HOST`                    | `127.0.0.1`                | Node server bind address.                                                                  |
| `PORT`                    | `3001`                     | Node server port.                                                                          |
| `DATABASE_PATH`           | `data/pump.sqlite`         | Normal-mode SQLite database.                                                               |
| `PUMP_TEST_DATABASE_PATH` | `data/pump-testing.sqlite` | Test-mode SQLite database.                                                                 |
| `PUMP_TEST_MODE`          | Disabled                   | Set to `true` to enable test mode; the `:test` launch commands also enable it explicitly.  |
| `COOKIE_SECURE`           | Disabled                   | Set to `true` to add `Secure` to the Node server's session cookie when serving over HTTPS. |

Relative database paths are resolved from the working directory. Local database files, environment files, build output, and test artifacts are ignored by Git. If you change the API port during development, update the proxy target in [vite.config.ts](vite.config.ts) to match.

## Deploy to Cloudflare

The public deployment serves static client assets and routes API requests through a Worker to one SQLite-backed Durable Object. It uses normal game rules and separate storage from local development. Public session cookies are always Secure, HttpOnly, and SameSite=Strict.

Create a Cloudflare account and review [wrangler.jsonc](wrangler.jsonc), especially the Worker name, before your first deployment. Then run:

```sh
npm run test:unit
npm run deploy:check
npx wrangler login
npm run deploy
```

Wrangler handles account authorization and prints the deployed URL. Open that URL to verify wallet creation, normal pop behavior, and refresh recovery. Running `npm run deploy` again updates the same deployment; it does not start a local game server.

Keep the Worker identity, Durable Object class/binding, migration history, and object name `pump-public-v1` stable to retain the same stored game data across deployments.

The public API adds room admission, presence tracking, and persistent request throttling. Configure these values in the `vars` section of `wrangler.jsonc`:

| Setting                       | Default | Purpose                                                                                           |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `MAX_ACTIVE_PLAYERS`          | `25`    | Maximum admitted wallets. Multiple tabs sharing a wallet use one slot.                            |
| `PLAYER_IDLE_SECONDS`         | `180`   | Inactivity timeout after the latest successful admitted request; allowed range: 120–3600 seconds. |
| `SESSION_REQUESTS_PER_MINUTE` | `120`   | Token replenishment rate per wallet.                                                              |
| `SESSION_REQUEST_BURST`       | `30`    | Immediate request allowance per wallet.                                                           |
| `IP_REQUESTS_PER_MINUTE`      | `1000`  | Token replenishment rate per client IP.                                                           |
| `IP_REQUEST_BURST`            | `100`   | Immediate request allowance per client IP.                                                        |

Visible idle clients send presence heartbeats about once per minute; hidden tabs stop heartbeats. When the room is full, existing wallets can still read state and cash out a saved flight. Starting or pumping requires admission. Rate-limit responses include `Retry-After`.

## Architecture and project structure

The TypeScript browser client sends JSON actions to the API and renders the returned wallet, current round, and recent history. The server validates requests and owns all outcomes and balance changes; the client never decides whether a pump survives.

[PumpEngine.ts](src/engine/PumpEngine.ts) contains pure, deterministic curve and payout functions with no HTTP or database dependencies. [PumpService.ts](src/server/PumpService.ts) combines that engine with seed generation, persisted rounds, and transactional wallet/ledger updates. Local development uses Node's SQLite adapter; the public deployment runs the same service through a Cloudflare Worker and a Durable Object SQLite adapter behind a shared storage interface.

| Path                                     | Responsibility                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| [src/client/](src/client/)               | Browser controls, rendering, audio, world geometry, and animation.         |
| [src/client/public/](src/client/public/) | Artwork, sprite atlases, audio, and fonts.                                 |
| [src/engine/](src/engine/)               | Integer-based payout calculations and versioned risk curves.               |
| [src/shared/](src/shared/)               | Shared settings and API types.                                             |
| [src/server/](src/server/)               | Game service, schema, ledger, Node HTTP server, public API, and admission. |
| [src/worker/](src/worker/)               | Cloudflare entry point and Durable Object SQLite adapter.                  |
| [tests/](tests/)                         | Engine, service, API, client, Worker, and browser checks.                  |

## Tradeoffs and next steps

- **Whole-cent payouts:** restricting bets to ten-cent increments makes current payouts exact in cents while keeping RTP close to 97%. Supporting every whole-cent stake would require revisiting the rounding bounds and extending the proof. Strictly increasing risk also makes some steps return slightly less than the nominal 97% target.
- **Anonymous wallets:** cookie sessions provide immediate play without account setup. Clearing cookies loses access to that wallet, and there is no cross-device recovery. Account-based identity and recovery would be separate work.
- **One shared public room:** a single SQLite-backed Durable Object gives mutations one transactional storage boundary. The default 25-wallet admission cap keeps the demo bounded. Higher capacity needs load testing and storage-write measurements before changing that limit.
- **Desktop layout:** the current UI prioritizes the desktop flight scene. A mobile layout and global Space/Enter gameplay shortcuts remain follow-up work. Seed details are available, while a dedicated page for recomputing arbitrary past rounds is still optional future work.
- **Media production:** the game includes functioning sound, music, and animations. More custom sound effects, original background music, and bespoke animations would improve the presentation and are the main polish priorities with more time.

## Time spent and scope

The maintainer reports **12 hours** spent on the project. The time budget prioritized the game rules, wallet correctness, backend review, and a playable full-stack experience.

Further custom sound design, custom animation work, and better or original background music were deferred because producing those assets would add substantial time. Existing sound, music, and animation are included in the delivered implementation; the deferred work is additional polish. The functional limitations and rule choices are recorded above.

See [AI_USAGE.md](AI_USAGE.md) for the recorded use of AI assistance.
