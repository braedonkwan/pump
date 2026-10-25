# AI usage

OpenAI Codex produced most of the implementation code and assisted with tests, debugging, documentation, and commit-message drafting. Work followed the maintainer's planning and review.

## Division of work

- **Maintainer:** high-level planning beyond the supplied PDF, product and scope decisions, and manual review of the backend with particular attention to RTP calculations and wallet balances.
- **Delegated to AI:** most code implementation, refactoring, test writing, bug reproductions, fixes, and documentation. The maintainer's main contribution was planning and review; this submission does not claim that most implementation code was handwritten.

## Recorded contributions

The confirmed assistance in this development session includes:

- Inspecting the repository and drafting a commit message from the working changes.
- Making normal gameplay the default for local development and compiled startup, while preserving explicit test-mode commands.
- Reproducing and fixing wallets stuck below the minimum bet. Recovery preserves active flights and records the exact refill credit in the ledger.
- Fixing old start and cashout retries so their responses show the current flight without repeating a debit or payout.
- Correcting room lease renewal so the inactivity timeout follows the latest successful activity and survives service restarts.
- Preventing delayed heartbeat successes or failures from overwriting newer connection errors.
- Adding or extending service, client-action, wallet-ledger, public API, Worker, and browser regression coverage.
- Writing the project README and this usage record.

## An AI mistake caught during review

The AI-written refill logic originally handled a wallet at exactly zero, leaving balances of one to nine cents below the minimum bet with no way to continue. A legal ten-cent bet can pay eleven cents; later losses can therefore leave a one-cent balance. This case was reproduced during review.

The correction refills any balance below the minimum only after the active round finishes, credits the exact difference needed to reach the starting balance, and records that difference in the ledger. The [ledger regression test](tests/ledger.test.ts) plays through the one-cent case, forces a ledger failure to verify rollback, and checks that a retry grants only one refill. This was a concrete correction to AI-generated code, verified through reproduction and tests.

## How changes were checked

Reported bugs were exercised with focused reproductions. Regression tests were run against the earlier behavior to confirm the failures, then rerun after implementation. Verification during the recorded work included TypeScript checks, the Node test suites, Miniflare Worker tests, builds, Prettier checks, and headless Chrome checks for the relevant browser changes.

Tests used isolated fixtures rather than modifying the project's saved local wallets. The ledger checks covered transaction rollback, exact refill accounting, and repeated requests. Client checks covered response ordering, disconnection, and recovery.

The [README verification section](README.md#verification) lists commands for repeating the checks. Test results describe the scenarios covered by those checks; they do not establish correctness for every possible input or runtime.

## Time and scope

The maintainer reports **12 hours** of work. Additional custom sound effects, bespoke animations, and improved or original background music were deferred because of their production time. The delivered game includes existing effects, animations, and music. See the [README](README.md#time-spent-and-scope) for the time statement and [tradeoffs](README.md#tradeoffs-and-next-steps) for remaining work.

## Scope of this record

This file documents confirmed code and documentation assistance from the recorded session. Earlier implementation history may include other assistance that is not described here. The origin and licensing of the artwork, audio, fonts, and third-party dependencies are outside this record.
