

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
You are given a blob of unordered user transactions in the public mempool, (represented as little boxes,) and the objective is to rearrange the victim's boxes (and insert your own transactions as boxes) in a way that maximize your own profit.

By making the UI and UX extremely simple, minimal, and generic, Sandwiching and atomic arbitrage strategies fall out automatically.

If you miss any MEV opportunities, you will see a competing bot come in and swoop up the opportunities, outbidding you.

## Further details:
After submitting your answer, you can see the blocks execute sequentially; and you see prices update in real time.

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
level 3: triangular atomic arb
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


## 
