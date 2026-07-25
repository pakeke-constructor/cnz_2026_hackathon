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

// A no-op transaction: it steps the chain forward but changes nothing. The
// block's "start"/"end" spacer boxes are backed by these, so they flow through
// the SAME simulation and rendering path as real transactions — they just
// leave every price where it was (a flat segment on the graph).
class Noop extends Transaction {
  constructor(id: string, readonly text: string) {
    super(id, "SYSTEM");
  }
  simulate(s: State): State {
    return s;
  }
  label(): string {
    return this.text;
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
// Simulation: walk the block box-by-box, recording EVERY pool's price
// BEFORE and AFTER each box. One entry per box (spacers included — their
// Noop leaves prices unchanged). The graph draws each box as a segment from
// its before-price to its after-price, so a transaction visibly moves the
// price across its own width, and a spacer is simply flat.
// ---------------------------------------------------------------------
interface BoxSim {
  readonly el: HTMLElement;
  readonly txn: Transaction;
  readonly before: ReadonlyMap<Asset, number>;
  readonly after: ReadonlyMap<Asset, number>;
  // The PLAYER's balance of this box's traded asset just BEFORE it executes.
  // Used to cap a SELL slider so you can't sell more than you're holding at
  // that point in the block. NaN for boxes that aren't player swaps.
  readonly playerAssetBefore: number;
}

function simulateBoxes(level: Level, boxes: readonly BlockBox[]): {
  assets: readonly Asset[];
  sims: readonly BoxSim[];
} {
  const assets = level.pools.map((p) => p.asset);
  let s = initialState(level);
  const sims: BoxSim[] = [];
  for (const { el, txn } of boxes) {
    const before = new Map<Asset, number>(assets.map((a) => [a, s.price(a)]));
    const playerAssetBefore =
      txn instanceof Swap && txn.owner === "PLAYER"
        ? s.balance("PLAYER", txn.asset)
        : NaN;
    s = txn.simulate(s);
    const after = new Map<Asset, number>(assets.map((a) => [a, s.price(a)]));
    sims.push({ el, txn, before, after, playerAssetBefore });
  }
  return { assets, sims };
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
  if (opts.editable) el.classList.add("mine"); // player's own, discardable txn
  el.dataset.id = txn.id;

  const action = document.createElement("div");
  action.className = "action";
  action.textContent = txn.label();

  const amt = document.createElement("div");
  amt.className = "amt";
  amt.textContent = `${swap.qty} ${swap.asset}`;

  const owner = document.createElement("div");
  owner.className = "owner";
  owner.textContent = opts.victim ? txn.owner : "MEV \u{1F608}";

  el.append(owner, action, amt);

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

// The block's execution order is its VISUAL left-to-right order (the single
// source of truth). We read every child that resolves to a transaction —
// including the pinned spacer boxes — and sort by on-screen x. Because the
// graph measures the same rectangles, boxes and price line always agree.
interface BlockBox {
  readonly el: HTMLElement;
  readonly txn: Transaction;
}

function readBlock(): BlockBox[] {
  const boxes: BlockBox[] = [];
  for (const child of Array.from(blockArea.children)) {
    const el = child as HTMLElement;
    const txn = el.dataset.id ? txnById.get(el.dataset.id) : undefined;
    if (txn) boxes.push({ el, txn });
  }
  boxes.sort(
    (a, b) => a.el.getBoundingClientRect().left - b.el.getBoundingClientRect().left
  );
  return boxes;
}

// ---------------------------------------------------------------------
// Graph: price over the block. Each box is drawn as a segment spanning its
// OWN width — from the price before it ran to the price after — so a
// transaction visibly walks the price across itself and spacers are flat.
// The X of every point is read from the real box rectangles, so the line
// lines up EXACTLY with the boxes below.
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

// Update each editable SELL box's slider so its max never exceeds the player's
// holdings of that asset when the box runs. Returns true if any current value
// had to be clamped down (meaning quantities changed and the caller should
// re-simulate).
function capSellSliders(sims: readonly BoxSim[]): boolean {
  let clamped = false;
  for (const s of sims) {
    if (!(s.txn instanceof Swap) || s.txn.side !== "SELL") continue;
    const slider = s.el.querySelector<HTMLInputElement>("input.qty");
    if (!slider) continue; // victims aren't editable

    const cap = Math.max(0, Math.floor(s.playerAssetBefore));
    slider.max = String(cap);
    if (Number(slider.value) > cap) {
      slider.value = String(cap);
      const cur = txnById.get(s.txn.id) as Swap;
      txnById.set(s.txn.id, cur.withQty(cap)); // immutable edit
      const amt = s.el.querySelector<HTMLElement>(".amt");
      if (amt) amt.textContent = `${cap} ${cur.asset}`;
      clamped = true;
    }
  }
  return clamped;
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

  const boxes = readBlock();
  const { assets, sims } = simulateBoxes(level, boxes);
  blockArea.classList.toggle(
    "has-txns",
    boxes.some((b) => !(b.txn instanceof Noop))
  );

  // Cap every SELL slider at the player's inventory of that asset at the moment
  // the box runs — you can't sell DOGE you don't hold yet. Clamping a slider
  // down only ever frees up inventory for later boxes, so re-simulating once is
  // enough to settle; we redraw with the corrected quantities and bail.
  if (capSellSliders(sims)) {
    drawGraph(level);
    return;
  }

  // Each box's left/right edge in canvas space. A box owns the span [xL, xR];
  // the price enters at xL (before) and leaves at xR (after).
  const wrapRect = graphWrap.getBoundingClientRect();
  const edgesOf = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { xL: r.left - wrapRect.left, xR: r.right - wrapRect.left };
  };

  // ----- Y scale: auto-fit, but always at least the [0..50] window -----
  const allPrices: number[] = [];
  for (const s of sims)
    for (const a of assets) allPrices.push(s.before.get(a)!, s.after.get(a)!);
  for (const p of level.pools) allPrices.push(p.price);
  const pMax = Math.max(...allPrices);
  const Y_LO = 0;
  const Y_HI = Math.max(Y_MIN_TOP, Math.ceil((pMax * 1.1) / 10) * 10);
  const padL = 44, padR = 12, padT = 10, padB = 14;
  const plotH = cssH - padT - padB;
  const rightX = cssW - padR;
  const yOf = (price: number) =>
    padT + plotH * (1 - (price - Y_LO) / (Y_HI - Y_LO));

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

  // ----- faint column behind each price-changing (non-spacer) box -----
  ctx.fillStyle = "rgba(88,166,255,0.06)";
  for (const s of sims) {
    if (s.txn instanceof Noop) continue;
    const { xL, xR } = edgesOf(s.el);
    ctx.fillRect(xL, padT, xR - xL, plotH);
  }

  // ----- one line per asset -----
  // Walk the boxes in order. For each box draw before->after across its width;
  // the flat gaps between boxes connect automatically (before == prev after).
  const drawDot = (x: number, y: number) => {
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  };

  for (const asset of assets) {
    const color = assetColor(assets, asset);

    // Draw box-by-box rather than as one path, so a box that is one of the
    // PLAYER's own transactions can be rendered bold + glowing — making it
    // obvious on the graph exactly where YOUR trades move the price.
    let prevX = 0, prevY = 0;
    sims.forEach((s, i) => {
      const { xL, xR } = edgesOf(s.el);
      const yB = yOf(s.before.get(asset)!);
      const yA = yOf(s.after.get(asset)!);

      // Flat connector across the gap from the previous box (always normal).
      if (i > 0) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(xL, yB);
        ctx.stroke();
      }

      // The box's own segment: bold + glow when it's the player's trade.
      const mine = s.txn.owner === "PLAYER";
      ctx.strokeStyle = color;
      ctx.lineWidth = mine ? 4 : 2;
      if (mine) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
      }
      ctx.beginPath();
      ctx.moveTo(xL, yB);
      ctx.lineTo(xR, yA);
      ctx.stroke();
      ctx.shadowBlur = 0;

      prevX = xR;
      prevY = yA;
    });

    // dots at every box boundary (start of first box, then each box's end)
    ctx.fillStyle = color;
    if (sims.length) {
      const first = edgesOf(sims[0].el);
      drawDot(first.xL, yOf(sims[0].before.get(asset)!));
      for (const s of sims) {
        const { xR } = edgesOf(s.el);
        drawDot(xR, yOf(s.after.get(asset)!));
      }
    }

    // asset label riding the final flat (end-spacer) segment
    if (sims.length) {
      const last = sims[sims.length - 1];
      const { xR } = edgesOf(last.el);
      ctx.fillStyle = color;
      ctx.font = "600 11px ui-sans-serif, system-ui";
      ctx.textAlign = "right";
      ctx.fillText(asset, xR - 2, yOf(last.after.get(asset)!) - 5);
      ctx.textAlign = "left";
    }
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
  const id = kind; // stable ids "lead"/"trail"
  txnById.set(id, new Noop(id, kind === "lead" ? "start" : "end"));
  const el = document.createElement("div");
  el.className = "spacer";
  el.dataset.spacer = kind;
  el.dataset.id = id; // resolves to the Noop, so it flows through the sim
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

  // While a player's own box is being dragged, turn the mempool into a red
  // "drop to cancel" zone. Any drag that starts on a `.mine` box lights it up.
  const onStart = (evt: any) => {
    if ((evt.item as HTMLElement).classList.contains("mine")) {
      mempool.classList.add("cancel-mode");
    }
  };
  const onEnd = () => mempool.classList.remove("cancel-mode");

  // Block: the ordered list the player submits.
  Sortable.create(blockArea, {
    group: { name: "txns", pull: true, put: true },
    animation: 150,
    forceFallback: true,
    draggable: ".txn",         // spacers aren't `.txn`, so they never move
    filter: "input",           // let the qty slider work without starting a drag
    preventOnFilter: false,
    onStart,
    onEnd,
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

  // Mempool: victims can be pulled into the block (and back). Dropping one of
  // the PLAYER's own transactions here DISCARDS it — that's how you throw a
  // trade away. Stray palette clones dropped here are junk and removed too.
  Sortable.create(mempool, {
    group: { name: "txns", pull: true, put: true },
    animation: 150,
    forceFallback: true,
    onStart,
    onEnd,
    onSort: onChange,
    onAdd: (evt: any) => {
      const el: HTMLElement = evt.item;
      const id = el.dataset.id;
      const txn = id ? txnById.get(id) : undefined;
      if (!txn || txn.owner === "PLAYER") {
        if (id && txn && txn.owner === "PLAYER") txnById.delete(id);
        el.remove();
      }
      mempool.classList.remove("cancel-mode");
      onChange();
    },
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
