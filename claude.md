

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
    // Linear AMM: a pool's entire state is just its current price.
    // (Slope is 1 for now: buying 1 DOGE moves price +1, selling 1 DOGE moves price -1.)
    asset: string
    price: number
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

## Discrete price binning, with a linear AMM:

A linear AMM with discrete values works well, and it's a *great* simplification for teaching. 


### Why it works well:
What's great is that we can make the prices discrete: e.g. in the range 1 to 30.
From there, the player can size there order easily with discrete values on a slider. No need to 


### The trap: If you price trades naively, there's an infinite money glitch:
The trap: charging the **spot price** for the whole trade. Say price = 100, buying 10 DOGE moves it
to 110.

- Buy 10 DOGE "at 100" → pay **1000**, price → 110.
- Sell 10 DOGE "at 110" → get **1100**, price → 100.
- **Net: +100 for free.** No victim, no risk. That's your infinite money glitch (it's `q²` every
  round trip).

The bug is that you bought the *whole* block at the old price but sold it at the new price. Real
markets don't let you do that — you walk the price as you trade.

### The fix: charge the average price of the move (the trapezoid)

A trade sweeps the price from `p` to `p ± q`, so you pay/receive the **average** over that sweep:

```
Buy  q DOGE:  cost     = q · (p + q/2),   price → p + q
Sell q DOGE:  proceeds = q · (p − q/2),   price → p − q
```

Same example, done right:
- Buy 10 at avg (100+110)/2 = 105 → pay **1050**, price → 110.
- Sell 10 at avg (110+100)/2 = 105 → get **1050**, price → 100.
- **Net: 0.** Glitch gone.

### Why this is provably glitch-free

With average pricing, the USDC needed to move a pool's price from `a` to `b` is exactly
`(b² − a²)/2`. That's a **state function** — it depends only on the start and end price, never on the
path. So *any* sequence of trades that returns the price to where it started nets exactly zero USDC.
There is no closed loop that prints money. Profit is only possible when *someone else* moves the price
between your buy and your sell — which is precisely MEV. That's the property you want, and it's
mathematically guaranteed, not just "seems fine."

Quick sandwich sanity check with a victim in the middle (price 100):

| step | trade | avg price | USDC | price after |
|---|---|---|---|---|
| you front-run | buy 10 | 105 | −1050 | 110 |
| victim | buy 20 | 120 | (pays 2400) | 130 |
| you back-run | sell 10 | 125 | +1250 | 120 |

Your profit = **+200**, you end holding 0 DOGE, and it came entirely from the victim's price push.
Remove the victim and you'd net exactly 0. Correct on both counts.


### Two small guardrails

1. **Keep price above 0.** Selling pushes price down linearly, so a big enough sell (or a level that
   allows it) could cross zero and make the trapezoid math go weird. Design levels so price stays
   positive, or floor it.
2. **You can drop pool reserves entirely.** The linear pool doesn't need `pool1/pool2` — its whole
   state is just a current `price` (and an implicit slope, 1 for now). That simplifies the `LP` class
   to basically `{ asset, price }`.

### Is this actually different from a traditional xy=k AMM?

**Two ways yes, one important way no.**

**No (the part that matters for safety):** xy=k is *also* glitch-free, for the exact same reason. In
both models the cost of a trade is the area under a price curve, which makes it a state function —
round trips net zero in xy=k too. So switching to linear is **not** fixing a glitch in xy=k. xy=k was
never glitchy. The real reason to switch is *not* safety.

**Yes (the shape):** they're different curves.
- **xy=k is a hyperbola.** Price = ratio of reserves. Price impact *accelerates* — the more you buy,
  the more each additional unit costs, and price can approach 0 or ∞ but never reach them.
  Self-bounding.
- **Linear is a straight line.** Every DOGE moved shifts price by the same fixed amount, no matter the
  current price. Constant impact. Price *can* cross zero (hence the floor guardrail).

**Yes (why we actually want it):** the real reason to pick linear is **simplicity and teachability**:
- "Buy 10 → price +10" is mental math a player groks instantly. xy=k requires explaining reserve
  ratios.
- It lines up perfectly with **discrete integer bins** — trapezoid areas stay clean round numbers.
- No reserves to track; a pool's entire state is one number, `price`.

So: same *family* (both conservative bonding curves, both glitch-free), different *shape* (straight vs
hyperbolic), and we choose straight because it's the one a hackathon player can follow in their head.
