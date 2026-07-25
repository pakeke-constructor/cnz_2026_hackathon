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
  // The full immutable chain snapshots bracketing this box. Invariants read
  // whatever they need off `stateBefore` locally (e.g. the player's asset
  // balance, to cap a SELL slider) — no per-rule scalars on the sim. The
  // playback engine reads `stateBefore`/`stateAfter` to show live balances as
  // the playhead crosses each box. `stateBefore` of box k == `stateAfter` of
  // box k-1, by construction.
  readonly stateBefore: State;
  readonly stateAfter: State;
}

function simulateBoxes(level: Level, boxes: readonly BlockBox[]): {
  assets: readonly Asset[];
  sims: readonly BoxSim[];
} {
  const assets = level.pools.map((p) => p.asset);
  let s = initialState(level);
  const sims: BoxSim[] = [];
  for (const { el, txn } of boxes) {
    const stateBefore = s; // immutable: safe to hand out as-is
    const before = new Map<Asset, number>(assets.map((a) => [a, s.price(a)]));
    s = txn.simulate(s);
    const after = new Map<Asset, number>(assets.map((a) => [a, s.price(a)]));
    sims.push({ el, txn, before, after, stateBefore, stateAfter: s });
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
  action.textContent = `${swap.side === "BUY" ? "Buy" : "Sell"} ${swap.qty} ${swap.asset}`;

  const owner = document.createElement("div");
  owner.className = "owner";
  owner.textContent = opts.victim ? txn.owner : "MEV \u{1F608}";

  el.append(owner, action);

  if (opts.editable) {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "qty";
    slider.min = "0";
    slider.max = "40";
    slider.step = "1";
    slider.value = String(swap.qty);
    // THE ONLY sanctioned DOM->state boundary. Data flows one way everywhere
    // else (immutable txnById -> rendered DOM); reading the DOM back into logic
    // is what caused the sell-clamp bug. Reading slider.value is valid HERE and
    // only here, because the user physically moving the slider IS the new intent.
    slider.addEventListener("input", () => {
      const q = Number(slider.value);
      const cur = txnById.get(txn.id) as Swap;
      txnById.set(txn.id, cur.withQty(q)); // immutable edit
      action.textContent = `${swap.side === "BUY" ? "Buy" : "Sell"} ${q} ${swap.asset}`;
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

// ---------------------------------------------------------------------
// Validation — generic, idempotent, run to a fixpoint every frame.
//
// An "invariant" inspects the simulated block and CORRECTS any transaction
// data that violates a rule (e.g. you can't sell DOGE you aren't holding yet).
// Each invariant returns `true` if it actually changed something.
//
// Why a loop instead of one pass? One correction can change the state a LATER
// box sees: if you reduce a BUY, a SELL that comes after it now has less
// inventory to draw on and must be clamped too. A single top-down pass would
// miss that. So `validate` re-simulates and re-runs the invariants until
// nothing changes (capped at MAX_VALIDATION_PASSES for safety). This is O(n²)
// and deliberately dumb — but it's extremely robust and easy to extend.
//
// The whole thing rests on every invariant being IDEMPOTENT: validating an
// already-valid block must change nothing. That's what guarantees the loop
// reaches a fixpoint and settles instead of oscillating forever. New rules
// (can't spend USDC you don't have, flash-loan legs must balance, etc.) just
// get added to INVARIANTS below and inherit the same fixpoint machinery.
// ---------------------------------------------------------------------
const MAX_VALIDATION_PASSES = 5;

// Invariant: a SELL box can never sell more of an asset than the player holds
// at the moment it runs. We also keep each slider's `max` in sync so the UI
// can't even offer an illegal quantity.
function invariantSellInventory(sims: readonly BoxSim[]): boolean {
  let changed = false;
  for (const s of sims) {
    if (!(s.txn instanceof Swap) || s.txn.side !== "SELL") continue;
    const slider = s.el.querySelector<HTMLInputElement>("input.qty");
    if (!slider) continue; // victims aren't editable

    const cap = Math.max(0, Math.floor(s.stateBefore.balance("PLAYER", s.txn.asset)));
    // Compare against the TRANSACTION's qty (our source of truth), never the
    // slider's DOM value. Setting slider.max below the current value makes the
    // browser silently auto-clamp slider.value — so reading slider.value here
    // would see the already-clamped number and wrongly conclude "nothing to do,"
    // leaving the real txn data stale. Decide first, then sync the DOM.
    const cur = txnById.get(s.txn.id) as Swap;
    const clampedQty = Math.min(cur.qty, cap);
    if (clampedQty !== cur.qty) {
      txnById.set(s.txn.id, cur.withQty(clampedQty)); // immutable edit
      const action = s.el.querySelector<HTMLElement>(".action");
      if (action) action.textContent = `${cur.side === "BUY" ? "Buy" : "Sell"} ${clampedQty} ${cur.asset}`;
      changed = true;
    }
    slider.max = String(cap);
    slider.value = String(clampedQty);
  }
  return changed;
}

const INVARIANTS: readonly ((sims: readonly BoxSim[]) => boolean)[] = [
  invariantSellInventory,
];

// Re-simulate and apply every invariant until the block stops changing.
// Idempotent overall: calling it on an already-valid block is a no-op.
function validate(level: Level): void {
  for (let pass = 0; pass < MAX_VALIDATION_PASSES; pass++) {
    const { sims } = simulateBoxes(level, readBlock());
    let changed = false;
    for (const inv of INVARIANTS) changed = inv(sims) || changed;
    if (!changed) return;
  }
}

// Draw the price graph.
//
//   execFrac === undefined  → static, fully-revealed graph (between edits).
//   execFrac is a number    → an animation frame during playback. It is a
//                             FRACTIONAL box index in [0 .. sims.length]: e.g.
//                             2.6 means "the playhead is 60% of the way across
//                             box #2". Everything left of the playhead is drawn
//                             solid (already executed); everything to its right
//                             is dimmed (the future), and a glowing vertical
//                             playhead sweeps across — the "wipe".
function drawGraph(level: Level, execFrac?: number): void {
  const playing = execFrac !== undefined;

  // Correct the block to a fixpoint BEFORE we render, so what's drawn always
  // reflects legal quantities (sliders clamped to inventory, etc.). While a
  // playback is running the block is frozen, so skip the (idempotent) pass.
  if (!playing) validate(level);

  // Static redraws happen on every edit — reset the inventory panel to the
  // level's starting balances. During playback the engine drives the panel with
  // live balances instead, so leave it alone here.
  if (!playing) buildInventory(level);

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

  // ----- playhead geometry -----
  // Turn the fractional box index into an on-screen x, plus the interpolated
  // price of each asset at that instant. Left of `playheadX` is "executed".
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  let playheadX = Infinity;            // Infinity => reveal everything (static)
  let activeIdx = -1;                  // box currently under the playhead
  const playPrice = new Map<Asset, number>();
  if (playing && sims.length) {
    const f = Math.max(0, Math.min(execFrac!, sims.length));
    const k = Math.min(Math.floor(f), sims.length - 1);
    const t = Math.min(1, f - k);
    const { xL, xR } = edgesOf(sims[k].el);
    playheadX = f >= sims.length ? rightX : lerp(xL, xR, t);
    activeIdx = f >= sims.length ? -1 : k;
    for (const a of assets)
      playPrice.set(a, lerp(sims[k].before.get(a)!, sims[k].after.get(a)!, t));
  }

  // ----- faint column behind each price-changing (non-spacer) box -----
  // The box currently executing gets a brighter, warmer wash so the eye is
  // pulled to exactly where the action is happening right now.
  for (let i = 0; i < sims.length; i++) {
    const s = sims[i];
    if (s.txn instanceof Noop) continue;
    const { xL, xR } = edgesOf(s.el);
    ctx.fillStyle = i === activeIdx ? "rgba(88,166,255,0.16)" : "rgba(88,166,255,0.06)";
    ctx.fillRect(xL, padT, xR - xL, plotH);
  }

  // ----- one line per asset -----
  // Build each asset's polyline as a flat list of points — two per box:
  // (xL, before) then (xR, after). Consecutive boxes connect automatically, so
  // the flat gaps between boxes fall out for free. We draw the whole line
  // dimmed, then RE-draw it clipped to [0 .. playheadX] at full strength: that
  // clip is the wipe. Player boxes get a bold, glowing overlay on top.
  const pointsOf = (asset: Asset): [number, number][] => {
    const pts: [number, number][] = [];
    for (const s of sims) {
      const { xL, xR } = edgesOf(s.el);
      pts.push([xL, yOf(s.before.get(asset)!)]);
      pts.push([xR, yOf(s.after.get(asset)!)]);
    }
    return pts;
  };
  const strokePoly = (pts: [number, number][], color: string, width: number, glow: boolean) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    ctx.shadowBlur = 0;
  };
  const drawDot = (x: number, y: number) => {
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  };

  for (const asset of assets) {
    const color = assetColor(assets, asset);
    const pts = pointsOf(asset);

    // 1) full line, dimmed while playing (the "future"); solid when static.
    ctx.globalAlpha = playing ? 0.16 : 1;
    strokePoly(pts, color, 2, false);
    ctx.globalAlpha = 1;

    // 2) revealed portion: same line, clipped to everything left of the wipe.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, playheadX === Infinity ? cssW : playheadX, cssH);
    ctx.clip();
    strokePoly(pts, color, 2, false);
    // player trades bold + glowing, so it's obvious where YOU moved the price.
    sims.forEach((s, i) => {
      if (s.txn.owner !== "PLAYER") return;
      strokePoly([pts[2 * i], pts[2 * i + 1]], color, 4, true);
    });
    // boundary dots on the revealed side only.
    ctx.fillStyle = color;
    if (sims.length) {
      drawDot(pts[0][0], pts[0][1]);
      for (let i = 0; i < sims.length; i++) drawDot(pts[2 * i + 1][0], pts[2 * i + 1][1]);
    }
    ctx.restore();

    // 3) the live price dot riding the playhead.
    if (playing && playPrice.has(asset) && playheadX !== Infinity) {
      const y = yOf(playPrice.get(asset)!);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      drawDot(playheadX, y);
      ctx.shadowBlur = 0;
    }

    // asset label riding the final flat (end-spacer) segment.
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

  // ----- the playhead itself: a glowing vertical sweep line + top marker -----
  if (playing && playheadX !== Infinity) {
    ctx.save();
    const grad = ctx.createLinearGradient(playheadX - 6, 0, playheadX + 6, 0);
    grad.addColorStop(0, "rgba(88,166,255,0)");
    grad.addColorStop(0.5, "rgba(88,166,255,0.55)");
    grad.addColorStop(1, "rgba(88,166,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(playheadX - 6, padT, 12, plotH); // soft glow band
    ctx.strokeStyle = "rgba(160,205,255,0.95)";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "rgba(88,166,255,0.9)";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(playheadX, padT);
    ctx.lineTo(playheadX, padT + plotH);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // little triangle marker at the top of the sweep line
    ctx.fillStyle = "rgba(160,205,255,0.95)";
    ctx.beginPath();
    ctx.moveTo(playheadX - 5, padT);
    ctx.lineTo(playheadX + 5, padT);
    ctx.lineTo(playheadX, padT + 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
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

// Render the player's inventory panel from an immutable State. Used both for
// the STARTING inventory (static, between edits) and for LIVE balances that
// tick as the execution playhead crosses each box. We always render USDC first
// and then every pool asset — even at zero — so rows don't pop in and out and
// jump around as balances cross zero during playback.
function renderInventory(level: Level, state: State): void {
  const inv = document.getElementById("inventory") as HTMLElement;
  inv.innerHTML = "";
  const assets: Asset[] = [USDC, ...level.pools.map((p) => p.asset)];
  for (const asset of assets) {
    const amount = state.balance("PLAYER", asset);
    const row = document.createElement("div");
    row.className = "inv-row";
    if (asset !== USDC && Math.abs(amount) > 1e-9) row.classList.add("exposed"); // holding a risky asset
    const a = document.createElement("span");
    a.className = "inv-asset";
    a.textContent = asset;
    const v = document.createElement("span");
    v.className = "inv-amt";
    // round to whole units; USDC can show a sign so extraction reads clearly.
    v.textContent = Math.round(amount).toLocaleString();
    row.append(a, v);
    inv.appendChild(row);
  }
}

// Reset the inventory panel to the level's starting balances.
function buildInventory(level: Level): void {
  renderInventory(level, initialState(level));
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

// ---------------------------------------------------------------------
// Execution engine — step through the block box-by-box in real time.
//
// A run first freezes the block and computes the WHOLE simulation up front
// (the outcome is deterministic; only its *reveal* is animated). Then a single
// requestAnimationFrame loop advances a wall-clock playhead across the boxes:
// each frame we map elapsed-ms -> a fractional box index and hand it to
// drawGraph, which wipes the price line in from the left. As the playhead
// crosses each box boundary we tick the inventory panel to that box's state.
//
// `currentExecution` is the single source of truth for "are we playing, and
// where". It holds the frozen sim, the timing schedule, and the live cursor.
// ---------------------------------------------------------------------

// Per-box wipe durations (ms). Real transactions get a beat to be read; the
// flat start/end spacers zip by so the run doesn't feel padded.
const BOX_MS = 560;
const SPACER_MS = 240;

interface CurrentExecution {
  readonly level: Level;
  readonly mode: "simulate" | "submit";
  readonly assets: readonly Asset[];
  readonly sims: readonly BoxSim[];
  readonly starts: readonly number[]; // cumulative ms at which each box begins
  readonly total: number;             // total run duration (ms)
  readonly startMs: number;           // performance.now() when playback began
  raf: number;                        // active rAF handle (for cancellation)
  frac: number;                       // live cursor: fractional box index
  state: State;                       // chain state at the current box boundary
  elapsedMs: number;
  done: boolean;
}

let currentExecution: CurrentExecution | null = null;

// Map elapsed playback ms -> fractional box index, honouring each box's own
// duration (so spacers advance faster than trades).
function fracAtMs(exec: CurrentExecution, ms: number): number {
  if (ms >= exec.total) return exec.sims.length;
  for (let i = exec.sims.length - 1; i >= 0; i--) {
    if (ms >= exec.starts[i]) {
      const dur = (i + 1 < exec.starts.length ? exec.starts[i + 1] : exec.total) - exec.starts[i];
      return i + (dur > 0 ? (ms - exec.starts[i]) / dur : 0);
    }
  }
  return 0;
}

// Balances to show at cursor `frac`: the state entering the box under the
// playhead (== the state after the previous box), so the panel ticks the
// instant execution moves on to the next box. Once finished, the final state.
function stateAtFrac(exec: CurrentExecution, frac: number): State {
  if (!exec.sims.length) return initialState(exec.level);
  if (frac >= exec.sims.length) return exec.sims[exec.sims.length - 1].stateAfter;
  return exec.sims[Math.min(Math.floor(frac), exec.sims.length - 1)].stateBefore;
}

function stopExecution(): void {
  if (!currentExecution) return;
  cancelAnimationFrame(currentExecution.raf);
  currentExecution = null;
  document.body.classList.remove("playing");
}

// Kick off a run. `mode` only differs at the finish line: "submit" reveals the
// profit/exposure summary; "simulate" just settles back to the interactive
// graph so you can keep tweaking.
function runExecution(level: Level, mode: "simulate" | "submit"): void {
  stopExecution();                 // restart cleanly if one was already playing
  hideResult();
  validate(level);                 // never play a stale/illegal block
  const { assets, sims } = simulateBoxes(level, readBlock());
  if (!sims.length) return;

  // Build the timing schedule: cumulative start-time of each box.
  const starts: number[] = [];
  let acc = 0;
  for (const s of sims) {
    starts.push(acc);
    acc += s.txn instanceof Noop ? SPACER_MS : BOX_MS;
  }

  const exec: CurrentExecution = {
    level, mode, assets, sims, starts, total: acc,
    startMs: performance.now(), raf: 0, frac: 0,
    state: sims[0].stateBefore, elapsedMs: 0, done: false,
  };
  currentExecution = exec;
  document.body.classList.add("playing"); // freeze interaction while it plays

  const tick = () => {
    if (currentExecution !== exec) return; // superseded by a newer run
    const ms = performance.now() - exec.startMs;
    exec.elapsedMs = Math.min(ms, exec.total);
    exec.frac = fracAtMs(exec, ms);
    exec.state = stateAtFrac(exec, exec.frac);
    drawGraph(level, exec.frac);
    renderInventory(level, exec.state);

    if (ms < exec.total) {
      exec.raf = requestAnimationFrame(tick);
      return;
    }
    // ----- finished: rest on the fully-revealed final frame -----
    exec.done = true;
    exec.elapsedMs = exec.total;
    exec.state = exec.sims[exec.sims.length - 1].stateAfter;
    drawGraph(level, exec.sims.length);
    renderInventory(level, exec.state);
    currentExecution = null;
    document.body.classList.remove("playing");
    showResult(level, exec.sims, mode);
  };
  exec.raf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------
// Result summary (shown after an execution completes).
// ---------------------------------------------------------------------
const VALIDATOR_BRIBE_RATE = 0.98;

interface Settlement {
  readonly grossGains: number;
  readonly gasFees: number;
  readonly profitBeforeBribe: number;
  readonly validatorBribe: number;
  readonly botProfit: number;
}

function calculateSettlement(grossGains: number, transactionCount: number): Settlement {
  const gasFees = transactionCount * 0.3;
  const profitBeforeBribe = grossGains - gasFees;
  const validatorBribe = Math.max(0, profitBeforeBribe) * VALIDATOR_BRIBE_RATE;
  const botProfit = profitBeforeBribe - validatorBribe;
  return { grossGains, gasFees, profitBeforeBribe, validatorBribe, botProfit };
}

function hideResult(): void {
  const box = document.getElementById("result");
  if (box) box.classList.add("hidden");
}

function showResult(level: Level, sims: readonly BoxSim[], mode: "simulate" | "submit"): void {
  const finalState = sims[sims.length - 1].stateAfter;
  const startUSDC = initialState(level).balance("PLAYER", USDC);
  const endUSDC = finalState.balance("PLAYER", USDC);
  const transactions = sims.filter((sim) => sim.txn.owner === "PLAYER" && !(sim.txn instanceof Noop));
  const settlement = calculateSettlement(endUSDC - startUSDC, transactions.length);
  const victimLoss = Math.max(0, settlement.grossGains);
  const exposed = level.pools
    .map((p) => ({ asset: p.asset, amt: finalState.balance("PLAYER", p.asset) }))
    .filter((x) => Math.abs(x.amt) > 1e-9);
  const hash = `0x9984954${Math.floor(Math.random() * 0xfffff).toString(16).padStart(5, "0")}`;
  const cls = settlement.botProfit > 0 ? "win" : settlement.botProfit < 0 ? "loss" : "flat";
  const sign = settlement.botProfit > 0 ? "+" : settlement.botProfit < 0 ? "−" : "";
  const money = (value: number) => `$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  let warn = "";
  if (exposed.length) {
    const list = exposed.map((x) => `${Math.round(x.amt).toLocaleString()} ${x.asset}`).join(", ");
    warn = `<div class="result-warn">You're still holding ${list}. This is exposed to price movement in the next block. Sell back to USDC to lock in your profit.</div>`;
  }

  const box = document.getElementById("result") as HTMLElement;
  box.className = `result-${cls}`;
  box.innerHTML = `<div class="result-card">
    <div class="result-title">${mode === "simulate" ? "Simulated" : "Submitted"} block</div>
    <div class="result-hash">${hash}</div>
    <div class="result-profit">${sign}${money(settlement.botProfit)} bot profit</div>
    <div class="result-grid">
      <div class="result-row"><span>Victim funds lost</span><strong>${money(victimLoss)}</strong></div>
      <div class="result-row"><span>Profit before bribe</span><strong>${money(settlement.profitBeforeBribe)}</strong></div>
      <div class="result-row"><span>Validator bribe (96%)</span><strong>−${money(settlement.validatorBribe)}</strong></div>
      <div class="result-row"><span>Bot profit after bribe</span><strong>${money(settlement.botProfit)}</strong></div>
      <div class="result-row"><span>Total gas fees</span><strong>${money(settlement.gasFees)}</strong></div>
      <div class="result-row"><span>Transactions executed</span><strong>${transactions.length}</strong></div>
    </div>
    ${warn}
    <button id="result-close">Back to block builder</button>
  </div>`;
  (document.getElementById("result-close") as HTMLElement).onclick = () => {
    hideResult();
    drawGraph(level);
  };
}

function main(): void {
  currentLevel = LEVEL_1;
  buildPalette(currentLevel);
  buildInventory(currentLevel);
  buildBlock();
  buildMempool(currentLevel);
  setupDragging(currentLevel);
  drawGraph(currentLevel);
  window.addEventListener("resize", () => {
    // Mid-playback the rAF loop repaints anyway; only redraw here when idle.
    if (!currentExecution) drawGraph(currentLevel);
  });

  (document.getElementById("btn-simulate") as HTMLElement).onclick = () =>
    runExecution(currentLevel, "simulate");
  (document.getElementById("btn-submit") as HTMLElement).onclick = () =>
    runExecution(currentLevel, "submit");
}

main();
