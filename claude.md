

# Situation:
I am doing a web3 hackathon, hosted by Crypto New Zealand.
Deadline: 26th July, Sunday, 10am.


# Project and Goal:
Goal: I want to teach about MEV, and teach how MEV searching works.
Project: I will make a game where you rearrange transactions to maximize profit.

The most important thing is to keep it simple and intuitive.
Players don't want to be fudging around with addresses and slippage-tolerances. We want to get the idea across.

## Game:
You play as an MEV searcher:
You are given a blob of unordered user transactions in the public mempool, (represented as little boxes,) and the objective is to rearrange the victim's boxes (and insert your own transactions as boxes) in a way that maximizes your own profit.

By making the UI and UX extremely simple, minimal, and generic, Sandwiching and atomic arbitrage strategies fall out automatically.

If you miss any MEV opportunities, you will see a competing bot come in and swoop up the opportunities, outbidding you.

## Further details:
After submitting your answer, you can see the blocks execute sequentially; and you see prices update in real time. (Graph visual at top of screen.)

Here's what I'd want to add:

* Classic buy-side sandwiching
* Classic sell-side sandwiching
* Classic triangular arbitrage
* Liquidations
* Flash-loans (Not represented as boxes; but rather, represented as "containers" that users can put transactions in? This is because real flash-loans can't persist across different legs.)

There are 3 basic transaction types that the players can use:

* Swap pair (Buy Asset / Sell Asset)
* Flash loan block
* Liquidate function
For the 1st MVP, the only transaction-type should be "swap".

Also to keep it simple, we should avoid "Swap" as a transaction type to begin with, and instead, we should have super clear boxes, e.g. if `DOGE` is an asset under liquidity-pool DOGE-USDC, then we would have two transaction types the player can use: 'Buy DOGE' / 'Sell DOGE'. Keeps it simple and intuitive.

## Levels:
With levels, we would progressively provide more and more MEV opportunities for the player:
```
level 1: classic buy-side sandwich, 1 victim
level 2: classic buy-side sandwich, 2 victims chained
level 2: classic buy-side sandwich, 2 victims, but only 1 transaction fits. User must choose txn with best slippage tolerance.
level 3: triangular atomic arb (3 different assets)
level 4: 2 triangular arbs
level N: 8 victim buy-side sandwich
---- (SCOPE CREEP: Anything below this line is potentially beyond scope.)
level N: sell-side sandwich
level N: buy-side sandwich + triangular arb
level N: liquidation, 1 victim
level N: liquidation 1 victim + triangular arb
level N: flashloan + liquidation + flashloan-end
level N: flashloan + liquidation + arb + flashloan-end
final level (BONUS): Everything combined, flashloan, arb, buy-side-sandwich, liquidation, sell-side-sandwich, flashloan-end.
```

Once player presses "submit", we would walk through the flow super simply, and show exactly what happens at each step.

And, at the end, the player sees exactly who lost money, and how:
- In total, $19000 of user value was extracted
- Bribes to the proposer/builder is $17500
- Your profit: $1500!

The user will start with a bunch of USDC, and will be expected to end with USDC too.
If the user has any shitcoins left over, there should be a popup:
"Good work; you made profit! But a bunch of your money lies in unstable assets. This means you are exposed to price movements in the next block - swap back to USDC at the end to ensure you aren't exposed!"

## UI:
Bottom area: (1/3 of screen). The public mempool, containing all transactions as boxes. User can drag in whatever transactions they want.
Block-building-area: (middle 1/3 of screen) This is where the player drags transactions to order them.
LP-price-area: (top 1/3 of screen) This shows how the LP prices change over time. It lines up EXACTLY with the blocks; so when .
Left sidebar: This is where you go to create a new transaction. Drag and drop from the left sidebar to create 
Bottom-right buttons: Simulate, and Submit. Simulate tests the block, without saying whether it's optimal. Submit will properly submit it, and let you know whether your solution is optimal.


## TECH-STACK:
Use basic JS + HTML. 
Two files: 1 html file, 1 js file. Keep it super minimal and simple for now.
Use sortable.js for box rendering.

## ARCHITECTURE:
IMPORTANT: ALL DATA SHOULD BE IMMUTABLE.
Makes stuff simpler and less error prone.
```ts
class Level {
    // contains stuff for a level.
    transactions: List<VictimTransaction> 
    state: State

    // we explicitly whitelist the transactions types that are allowed for this level.
    // That way, instead of players being bombarded with new stuff, it's kept optimal.
    allowedOperations: [BUY(DOGE), SELL(DOGE)]

    // For example, for triangular arbitrage, we would want something like this:
    // allowedOperations: [
    //     BUY(DOGE), SELL(DOGE), BUY(XRP), SELL(XRP), SWAP(DOGE,XRP), SWAP(XRP,DOGE)
    // ]
}

class LP {
    asset1: string
    asset2: string
    pool1: number
    pool2: number
}

type Owner = string // "PLAYER" refers to the player's ownership
type Asset = string

class State {
    // this is the object that is created and "walks forwards" as transactions execute.
    // this essentially contains the entire blockchain state.
    // (This object is immutable! Returns copies of itself.)

    balances: Map<Owner, Map<Asset, number>>
    pools: List<LP>
}

type Mempool = List<VictimTransaction>
type Block = List<Transaction>


class Transaction {
    owner: Owner

    simulate(s: State): State {
        // this function returns a clone of itself with updated values.
        // think of it as "stepping forward 1 transaction" in the block.
        return new State(...)
    }
}

class Swap extends Transaction {
    assetIn: string
    assetOut: string
    amountIn: number
    amountOutMin: number
}

```

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

### Open detail to finalize together: the reference price
The one thing left to pin down is what each swap measures its slippage *against*:
- **Victim orders** → reference = the **genesis pool price** (what the user "saw" in the mempool
  before the block ran). This is *why* front-running works: you shove the price up to the victim's genesis-based tolerance edge and they still execute — just at a worse price.
- **Player orders** → reference = the spot price at the **start of their consecutive run** (so the split-equally rule holds).

We'll lock the exact formula when we write the sizing algorithm.

