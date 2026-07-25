
## SWAP SIZING, SLIPPAGE & GAS (design notes)

### Auto-sized swaps — the player never types a number
Swap sizes are **not** entered by the player. Every swap (victim or player) auto-computes
its own `amountIn` based on **where it is placed** in the block.

**Why:** the lesson of this game is ORDERING, not number-tuning. If players had to hand-tune
sizes we'd (a) bury the actual insight under fiddly optimization, and (b) turn "optimal" into a
continuous calculus problem that's painful to score. Auto-sizing keeps the player focused on the
one thing that teaches MEV: *which box goes where*. The size just falls out.

### The sizing rule: max out the slippage tolerance
Every swap has a slippage tolerance = how far it will let the execution price drift from its
**reference price** before it would revert. We size each swap to the **largest `amountIn` that sits
exactly at the edge of that tolerance** — it eats as much price impact as slippage allows, no more.

**Why "max out":** a rational trader/searcher pushes their trade as large as tolerance permits
(bigger = more value moved = realistic behavior). It also makes sizing **deterministic** — there is exactly one correct size, so no ambiguity and nothing to tune.

### Slippage tolerance is a GLOBAL CONSTANT, computed on the fly — never hardcoded per level
There is ONE slippage-tolerance constant in the code (e.g. 2%). Do **NOT** bake specific sizes or
slippage values into individual levels. Every size is derived live from the current pool state.

**Why:**
- **Less authoring.** A level is just "which victims + which allowed ops" — not a spreadsheet of tuned numbers.
- **No brittle / cheatable answers.** Sizes always stay self-consistent with the AMM math because they come from the live pool reserves, not a hand-typed constant that can drift out of sync.
- **Emergent difficulty for free.** As you chain more victims, the correct sizes and interactions fall out automatically — harder levels appear without hand-tuning.
- It's honestly not hard: it's a closed-form solve on the constant-product curve. *(algorithm TBD together.)*

### Consecutive same-direction orders SPLIT the tolerance equally
If N player BUYs sit back-to-back, they do **not** each independently max out and stack. They share
**one** slippage budget, split equally — so all N come out the **same size**, and together they reach the tolerance edge exactly once (same total impact as a single maxed-out BUY).

**Why:**
- **Matches intuition.** Chopping one buy into two back-to-back buys shouldn't magically let you move the price twice as far. Tolerance is a *budget*, not a per-box allowance.
- **Kills a degenerate exploit.** Otherwise players would spam duplicate boxes to blast through slippage. Splitting neutralizes that.
- Combined with gas (below), adding a redundant same-direction box only ever *costs* you — the
  correct incentive.

### Gas: flat 1 cent per transaction
Every transaction (victim or player) costs a constant **$0.01**, regardless of size.

**Why:**
- **Penalizes unnecessary transactions.** With zero cost, spamming boxes is never harmful and clean solutions aren't rewarded. A flat per-txn cost makes "fewer, smarter txns" win.
- **Creates the level-2 tension directly:** "only one txn fits — choose the victim with the best
  slippage tolerance." Gas is exactly what makes that trade-off real.
- **Flat, not size-based,** keeps it dead simple and keeps the teaching point about transaction COUNT and ordering — not fee optimization.

### Solution table: lay out the optimal solution explicitly (no tuned values)
We should lay out (via enums) *EXACTLY* what we expect the optimal solution to be like, WITHOUT
tuning values. eg:

```
solution = [BUY(DOGE), VICTIM_BUY(DOGE), VICTIM_BUY(DOGE), SELL(DOGE)]
```

And from there, we can just walk across the block, and compute values for the level on the fly;
guaranteeing it will work. This solution table is defined in the `Level` object.

EXTREMELY IMPORTANT DETAIL:
Since this game is quite emergent, it's *possible* that the player find solutions more optimal than our own.
If this is the case, then we should accept their solution as correct, and move on.

