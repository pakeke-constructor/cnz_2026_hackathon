// =====================================================================
// MEV Searcher — MVP
//
// You are an MEV searcher. Reorder the victim transactions in the public
// mempool and insert your own trades to extract profit. The price graph at
// the top lines up EXACTLY with the block boxes below (X = execution order).
//
// ARCHITECTURE (per CLAUDE.md): all domain state is IMMUTABLE.
//   State           — a snapshot of the chain (pools + balances). Never mutates;
//                     every helper returns a NEW State.
//   Transaction     — abstract; owns `simulate(s: State): State` ("step forward
//                     one transaction"). Subtypes (Swap, later FlashLoan,
//                     Liquidate) each carry their own effect. Simulation logic
//                     lives HERE, not in State — that's what lets new tx types
//                     drop in without touching the engine.
//   PlayerTxnMeta   — a factory for player order types. `generate(qty)` mints a
//                     fresh Transaction. The sidebar palette is built from a
//                     level's list of these.
//   Level           — seed pools + victim transactions + which player ops are
//                     allowed.
// =====================================================================

// Sortable is loaded globally from the CDN <script> in index.html.
declare const Sortable: any;

// ---------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------
type Owner = string; // "PLAYER" is the player; others are victims.
type Asset = string;
type Side = "BUY" | "SELL";

const USDC: Asset = "USDC"; // the numeraire every pool is quoted in.

// Linear AMM pool: its ENTIRE state is a current price (slope = 1).
// BUY(DOGE) == swap USDC -> DOGE and pushes price up; SELL pushes it down.
interface LP {
  readonly asset: Asset;
  readonly price: number;
}

// ---------------------------------------------------------------------
// State — immutable chain snapshot. Every mutator returns a new State.
// ---------------------------------------------------------------------
class State {
  constructor(
    readonly pools: ReadonlyMap<Asset, LP>,
    readonly balances: ReadonlyMap<Owner, ReadonlyMap<Asset, number>>
  ) {}

  price(asset: Asset): number {
    return this.pools.get(asset)?.price ?? NaN;
  }

  balance(owner: Owner, asset: Asset): number {
    return this.balances.get(owner)?.get(asset) ?? 0;
  }

  // Return a copy with `asset`'s pool set to `price`.
  withPrice(asset: Asset, price: number): State {
    const pools = new Map(this.pools);
    pools.set(asset, { asset, price });
    return new State(pools, this.balances);
  }

  // Return a copy with `delta` added to one owner/asset balance.
  credit(owner: Owner, asset: Asset, delta: number): State {
    const balances = new Map(this.balances);
    const prev = balances.get(owner) ?? new Map<Asset, number>();
    const next = new Map(prev);
    next.set(asset, (prev.get(asset) ?? 0) + delta);
    balances.set(owner, next);
    return new State(this.pools, balances);
  }
}

// ---------------------------------------------------------------------
// Transactions — the effect lives on the transaction itself.
// ---------------------------------------------------------------------
abstract class Transaction {
  constructor(readonly id: string, readonly owner: Owner) {}

  // Step the chain forward by this one transaction, returning a NEW State.
  abstract simulate(s: State): State;

  // Human-readable action for the UI, e.g. "Buy DOGE".
  abstract label(): string;
}

// A swap against a USDC-quoted linear pool, expressed intuitively as
// "Buy DOGE" / "Sell DOGE" rather than raw assetIn/assetOut.
//
// Trapezoid (average-price) fill — this is what makes the game glitch-free:
//   Buy  q: cost     = q * (p + q/2), price -> p + q
//   Sell q: proceeds = q * (p - q/2), price -> p - q
// Moving a pool from price a->b always costs (b^2 - a^2)/2, a state function,
// so any loop that returns the price to its start nets exactly 0. Profit is
// only possible when someone ELSE moves the price between your buy and sell —
// which is precisely MEV.
class Swap extends Transaction {
  constructor(
    id: string,
    owner: Owner,
    readonly asset: Asset,
    readonly side: Side,
    readonly qty: number
  ) {
    super(id, owner);
  }

  simulate(s: State): State {
    const p = s.price(this.asset);
    const q = this.qty;

    if (this.side === "BUY") {
      const cost = q * (p + q / 2);
      return s
        .withPrice(this.asset, p + q)
        .credit(this.owner, USDC, -cost)
        .credit(this.owner, this.asset, +q);
    } else {
      const proceeds = q * (p - q / 2);
      return s
        .withPrice(this.asset, Math.max(0, p - q)) // guardrail: price >= 0
        .credit(this.owner, USDC, +proceeds)
        .credit(this.owner, this.asset, -q);
    }
  }

  label(): string {
    return `${this.side === "BUY" ? "Buy" : "Sell"} ${this.asset}`;
  }

  // Immutable "edit": a copy of this swap with a new quantity.
  withQty(qty: number): Swap {
    return new Swap(this.id, this.owner, this.asset, this.side, qty);
  }
}

// ---------------------------------------------------------------------
// Player order factories — the sidebar palette is built from these.
// ---------------------------------------------------------------------
abstract class PlayerTxnMeta {
  abstract generate(qty: number): Transaction;
  abstract label(): string;
}

class BUY extends PlayerTxnMeta {
  constructor(readonly asset: Asset) { super(); }
  generate(qty: number): Transaction {
    return new Swap(newId("p"), "PLAYER", this.asset, "BUY", qty);
  }
  label(): string { return `Buy ${this.asset}`; }
}

class SELL extends PlayerTxnMeta {
  constructor(readonly asset: Asset) { super(); }
  generate(qty: number): Transaction {
    return new Swap(newId("p"), "PLAYER", this.asset, "SELL", qty);
  }
  label(): string { return `Sell ${this.asset}`; }
}

// ---------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------
interface Level {
  readonly pools: readonly LP[];
  readonly victims: readonly Transaction[];
  readonly allowedOperations: readonly PlayerTxnMeta[];
}

const LEVEL_1: Level = {
  // Classic buy-side sandwich, 1 victim.
  // Prices start in the 20–30 band so they sit nicely inside the fixed 0–50
  // Y axis (see drawGraph). Sizes are tuned so a sandwich stays under 50.
  pools: [{ asset: "DOGE", price: 25 }],
  victims: [new Swap("v1", "Alice", "DOGE", "BUY", 10)],
  allowedOperations: [new BUY("DOGE"), new SELL("DOGE")],
};

function initialState(level: Level): State {
  const pools = new Map<Asset, LP>(level.pools.map((p) => [p.asset, p]));
  const balances = new Map<Owner, ReadonlyMap<Asset, number>>([
    ["PLAYER", new Map<Asset, number>([[USDC, 100000]])],
  ]);
  return new State(pools, balances);
}

// ---------------------------------------------------------------------
// Simulation: walk the block, record EVERY pool's price after each txn.
// Each asset gets its own price series so the graph can draw one line per
// asset. A transaction only moves one pool; the others carry forward
// unchanged, so every series has one point per transaction.
// ---------------------------------------------------------------------
interface SimResult {
  readonly assets: readonly Asset[];
  readonly start: ReadonlyMap<Asset, number>;      // price before the block
  readonly series: ReadonlyMap<Asset, number[]>;   // price AFTER each txn
  readonly finalState: State;
}

function simulate(level: Level, block: readonly Transaction[]): SimResult {
  const assets = level.pools.map((p) => p.asset);
  let s = initialState(level);
  const start = new Map<Asset, number>(assets.map((a) => [a, s.price(a)]));
  const series = new Map<Asset, number[]>(assets.map((a) => [a, []]));
  for (const txn of block) {
    s = txn.simulate(s);
    for (const a of assets) series.get(a)!.push(s.price(a));
  }
  return { assets, start, series, finalState: s };
}

// ---------------------------------------------------------------------
// DOM: the block's DOM order is the source of truth for ORDER; `txnById`
// is the source of truth for DATA. Rendering just reflects those two.
// ---------------------------------------------------------------------
let seq = 0;
function newId(prefix: string): string {
  return `${prefix}${++seq}`;
}

const txnById = new Map<string, Transaction>();

// Build a box for a transaction. `editable` player boxes get a qty slider.
function txnEl(txn: Transaction, opts: { victim?: boolean; editable?: boolean } = {}): HTMLElement {
  const swap = txn as Swap;
  const el = document.createElement("div");
  el.className = "txn " + (swap.side === "BUY" ? "buy" : "sell");
  if (opts.victim) el.classList.add("victim");
  el.dataset.id = txn.id;

  const action = document.createElement("div");
  action.className = "action";
  action.textContent = txn.label();

  const amt = document.createElement("div");
  amt.className = "amt";
  amt.textContent = `${swap.qty} ${swap.asset}`;

  const owner = document.createElement("div");
  owner.className = "owner";
  owner.textContent = opts.victim ? txn.owner : "you";

  el.append(action, amt, owner);

  if (opts.editable) {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "qty";
    slider.min = "0";
    slider.max = "40";
    slider.step = "1";
    slider.value = String(swap.qty);
    slider.addEventListener("input", () => {
      const q = Number(slider.value);
      const cur = txnById.get(txn.id) as Swap;
      txnById.set(txn.id, cur.withQty(q)); // immutable edit
      amt.textContent = `${q} ${swap.asset}`;
      drawGraph(currentLevel);
    });
    el.appendChild(slider);
  }

  return el;
}

// Read the block order straight from the DOM and resolve to Transactions.
function readBlock(blockArea: HTMLElement): Transaction[] {
  const out: Transaction[] = [];
  for (const child of Array.from(blockArea.children)) {
    const id = (child as HTMLElement).dataset.id;
    const txn = id ? txnById.get(id) : undefined;
    if (txn) out.push(txn);
  }
  return out;
}

// ---------------------------------------------------------------------
// Graph: price over the block. X positions are measured from the actual
// transaction boxes so the line lines up EXACTLY with each box's center.
// ---------------------------------------------------------------------
const graph = document.getElementById("graph") as HTMLCanvasElement;
const graphWrap = document.getElementById("graph-wrap") as HTMLElement;
const blockArea = document.getElementById("block-area") as HTMLElement;

// Y axis auto-scales to fit all prices, but never shrinks below a [0..50]
// window — so small moves stay readable and the scale only grows when needed.
const Y_MIN_TOP = 50;

// One stable colour per asset, assigned by its position in the level's pools.
const ASSET_COLORS = ["#58a6ff", "#f778ba", "#3fb950", "#d29922", "#a371f7", "#ff7b72"];
function assetColor(assets: readonly Asset[], asset: Asset): string {
  const i = assets.indexOf(asset);
  return ASSET_COLORS[(i < 0 ? 0 : i) % ASSET_COLORS.length];
}

function drawGraph(level: Level): void {
  const ctx = graph.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  const cssW = graphWrap.clientWidth;
  const cssH = graphWrap.clientHeight;
  graph.width = Math.round(cssW * dpr);
  graph.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const block = readBlock(blockArea);
  const { assets, start, series } = simulate(level, block);

  // ----- Y scale: auto-fit, but always at least the [0..50] window -----
  const allPrices: number[] = [];
  for (const a of assets) {
    allPrices.push(start.get(a)!);
    for (const p of series.get(a)!) allPrices.push(p);
  }
  const pMax = allPrices.length ? Math.max(...allPrices) : 0;
  const Y_LO = 0;
  const Y_HI = Math.max(Y_MIN_TOP, Math.ceil((pMax * 1.1) / 10) * 10);
  const padL = 44, padR = 12, padT = 10, padB = 14;
  const plotH = cssH - padT - padB;
  const rightX = cssW - padR;
  const yOf = (price: number) =>
    padT + plotH * (1 - (price - Y_LO) / (Y_HI - Y_LO));

  // ----- X positions: measured from the real boxes below -----
  // Two immovable spacer boxes pad the block (see index.html). The price line
  // rides FLAT across the lead spacer (start price) and the trail spacer
  // (final price); the real transaction boxes sit in between. All positions
  // come from live layout, so nothing is hardcoded.
  const wrapRect = graphWrap.getBoundingClientRect();
  const centerX = (el: HTMLElement): number => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2 - wrapRect.left;
  };
  const realBoxes = (Array.from(blockArea.children) as HTMLElement[]).filter(
    (el) => el.dataset.id && txnById.has(el.dataset.id)
  );
  const leadEl = blockArea.querySelector('[data-spacer="lead"]') as HTMLElement | null;
  const trailEl = blockArea.querySelector('[data-spacer="trail"]') as HTMLElement | null;
  const leadX = leadEl ? centerX(leadEl) : padL;
  const trailX = trailEl ? centerX(trailEl) : rightX;

  blockArea.classList.toggle("has-txns", realBoxes.length > 0);

  // ----- gridlines + Y labels -----
  ctx.strokeStyle = "#2a3242";
  ctx.fillStyle = "#8b949e";
  ctx.lineWidth = 1;
  ctx.font = "11px ui-sans-serif, system-ui";
  const ticks = 5;
  for (let t = 0; t <= ticks; t++) {
    const price = Y_LO + ((Y_HI - Y_LO) * t) / ticks;
    const y = yOf(price);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(rightX, y);
    ctx.stroke();
    ctx.fillText(price.toFixed(0), 6, y + 4);
  }

  // ----- vertical guide under each transaction box -----
  ctx.strokeStyle = "rgba(88,166,255,0.15)";
  for (const el of realBoxes) {
    const x = centerX(el);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, cssH - padB);
    ctx.stroke();
  }

  // ----- one line per asset -----
  // Flat across the lead spacer at the start price, step once per transaction,
  // then flat across the trail spacer at the LAST SEEN price out to the right
  // edge. With no transactions it's a single flat line at the current price.
  const drawDot = (x: number, y: number) => {
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  };

  for (const asset of assets) {
    const color = assetColor(assets, asset);
    const startPrice = start.get(asset)!;
    const pts = series.get(asset)!;
    const n = Math.min(pts.length, realBoxes.length);
    const lastPrice = n ? pts[n - 1] : startPrice;

    // line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padL, yOf(startPrice));      // flat lead-in from the plot edge
    ctx.lineTo(leadX, yOf(startPrice));     // ...across the lead spacer
    for (let i = 0; i < n; i++) ctx.lineTo(centerX(realBoxes[i]), yOf(pts[i]));
    ctx.lineTo(trailX, yOf(lastPrice));     // flat across the trail spacer
    ctx.lineTo(rightX, yOf(lastPrice));     // ...out to the right edge
    ctx.stroke();

    // dots: start price, each resulting price, final price
    ctx.fillStyle = color;
    drawDot(leadX, yOf(startPrice));
    for (let i = 0; i < n; i++) drawDot(centerX(realBoxes[i]), yOf(pts[i]));
    drawDot(trailX, yOf(lastPrice));

    // asset label riding the flat tail on the right
    ctx.fillStyle = color;
    ctx.font = "600 11px ui-sans-serif, system-ui";
    ctx.textAlign = "right";
    ctx.fillText(asset, rightX - 2, yOf(lastPrice) - 5);
    ctx.textAlign = "left";
  }
}

// ---------------------------------------------------------------------
// Wire up: palette (from allowedOperations), mempool (victims), dragging.
// ---------------------------------------------------------------------
let currentLevel: Level = LEVEL_1;

// Palette templates carry NO data of their own; each carries the index of the
// PlayerTxnMeta it spawns. On drop we call that factory's generate().
function buildPalette(level: Level): void {
  const palette = document.getElementById("palette") as HTMLElement;
  palette.innerHTML = "";
  level.allowedOperations.forEach((meta, i) => {
    const el = document.createElement("div");
    el.className = "txn template " + (meta instanceof BUY ? "buy" : "sell");
    el.dataset.meta = String(i);

    const action = document.createElement("div");
    action.className = "action";
    action.textContent = meta.label();

    const hint = document.createElement("div");
    hint.className = "owner";
    hint.textContent = "drag to add";

    el.append(action, hint);
    palette.appendChild(el);
  });
}

// The block always contains two immovable spacer boxes pinned to its ends
// (via flex `order` in CSS). They give the price line a flat lead-in / run-out
// to ride across, marking where the price starts and ends. They are not `.txn`
// elements, so Sortable's `draggable: ".txn"` leaves them untouched.
function spacerEl(kind: "lead" | "trail"): HTMLElement {
  const el = document.createElement("div");
  el.className = "spacer";
  el.dataset.spacer = kind;
  el.textContent = kind === "lead" ? "start" : "end";
  return el;
}

function buildBlock(): void {
  blockArea.innerHTML = "";
  blockArea.append(spacerEl("lead"), spacerEl("trail"));
}

function buildMempool(level: Level): void {
  const mempool = document.getElementById("mempool") as HTMLElement;
  mempool.innerHTML = "";
  for (const v of level.victims) {
    txnById.set(v.id, v);
    mempool.appendChild(txnEl(v, { victim: true }));
  }
}

function setupDragging(level: Level): void {
  const mempool = document.getElementById("mempool") as HTMLElement;
  const palette = document.getElementById("palette") as HTMLElement;
  const onChange = () => drawGraph(level);

  // Block: the ordered list the player submits.
  Sortable.create(blockArea, {
    group: { name: "txns", pull: true, put: true },
    animation: 150,
    forceFallback: true,
    draggable: ".txn",         // spacers aren't `.txn`, so they never move
    filter: "input",           // let the qty slider work without starting a drag
    preventOnFilter: false,
    onSort: onChange,
    onAdd: (evt: any) => {
      // Dropped in from the palette: replace the template clone with a real,
      // editable player transaction minted by the corresponding factory.
      if (evt.from === palette) {
        const el: HTMLElement = evt.item;
        const meta = level.allowedOperations[Number(el.dataset.meta)];
        const txn = meta.generate(10);
        txnById.set(txn.id, txn);
        el.replaceWith(txnEl(txn, { editable: true }));
      }
      onChange();
    },
  });

  // Mempool: victims can be pulled into the block (and back).
  Sortable.create(mempool, {
    group: { name: "txns", pull: true, put: true },
    animation: 150,
    forceFallback: true,
    onSort: onChange,
  });

  // Palette: a source of templates. pull:'clone' leaves the template behind.
  Sortable.create(palette, {
    group: { name: "txns", pull: "clone", put: false },
    sort: false,
    animation: 150,
    forceFallback: true,
  });
}

function main(): void {
  currentLevel = LEVEL_1;
  buildPalette(currentLevel);
  buildBlock();
  buildMempool(currentLevel);
  setupDragging(currentLevel);
  drawGraph(currentLevel);
  window.addEventListener("resize", () => drawGraph(currentLevel));
}

main();
