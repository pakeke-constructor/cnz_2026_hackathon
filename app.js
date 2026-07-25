"use strict";
// =====================================================================
// MEV Searcher — MVP
// Goals for this pass:
//   1. Mempool of victim transactions, draggable.
//   2. Player transactions (BUY DOGE / SELL DOGE), draggable in from a palette.
//   3. Price graph at the top whose X axis lines up EXACTLY with the block's
//      transaction boxes (time = transaction position, left-to-right).
//
// ARCHITECTURE NOTE (per project spec): all domain state is IMMUTABLE.
// Simulation walks a fresh State forward one transaction at a time, returning
// a new State each step. Nothing mutates in place.
// =====================================================================
// Immutable blockchain state that "walks forward" as transactions execute.
class State {
    constructor(pools, balances) {
        this.pools = pools;
        this.balances = balances;
    }
    price(asset) {
        const lp = this.pools.get(asset);
        return lp ? lp.price : NaN;
    }
    // Apply one transaction, returning a NEW State (no mutation).
    //
    // Trapezoid (average-price) fill — this is what makes the game glitch-free:
    //   Buy  q: cost     = q * (p + q/2), price -> p + q
    //   Sell q: proceeds = q * (p - q/2), price -> p - q
    // Because moving a pool from price a->b always costs (b^2 - a^2)/2 (a state
    // function), any loop that returns the price to its start nets exactly 0.
    step(txn) {
        const lp = this.pools.get(txn.asset);
        if (!lp)
            return this;
        const p = lp.price;
        const q = txn.qty;
        let newPrice;
        let dUSDC; // change to owner's USDC
        let dAsset; // change to owner's DOGE
        if (txn.side === "BUY") {
            const cost = q * (p + q / 2);
            newPrice = p + q;
            dUSDC = -cost;
            dAsset = +q;
        }
        else {
            const proceeds = q * (p - q / 2);
            newPrice = Math.max(0, p - q); // guardrail: keep price >= 0
            dUSDC = +proceeds;
            dAsset = -q;
        }
        const newPools = new Map(this.pools);
        newPools.set(txn.asset, { asset: txn.asset, price: newPrice });
        const newBalances = new Map(this.balances);
        const prev = this.balances.get(txn.owner) ?? new Map();
        const nextOwner = new Map(prev);
        nextOwner.set("USDC", (prev.get("USDC") ?? 0) + dUSDC);
        nextOwner.set(txn.asset, (prev.get(txn.asset) ?? 0) + dAsset);
        newBalances.set(txn.owner, nextOwner);
        return new State(newPools, newBalances);
    }
}
const LEVEL_1 = {
    startPrice: 100,
    victims: [
        { id: "v1", owner: "Alice", side: "BUY", asset: "DOGE", qty: 20 },
    ],
    allowed: ["BUY", "SELL"],
};
function initialState(level) {
    const pools = new Map([["DOGE", { asset: "DOGE", price: level.startPrice }]]);
    const balances = new Map([
        ["PLAYER", new Map([["USDC", 100000], ["DOGE", 0]])],
    ]);
    return new State(pools, balances);
}
function simulate(level, block) {
    let s = initialState(level);
    const points = [];
    for (const txn of block) {
        s = s.step(txn);
        points.push({ price: s.price("DOGE"), txnId: txn.id });
    }
    return { start: level.startPrice, points };
}
// ---------------------------------------------------------------------
// DOM helpers / rendering
// ---------------------------------------------------------------------
let seq = 0;
function newId(prefix) {
    return `${prefix}${++seq}`;
}
// Registry mapping a DOM element's data-id -> the Txn it represents.
// The DOM (via Sortable) owns ORDER; this map owns the DATA.
const txnById = new Map();
function txnEl(txn, opts = {}) {
    const el = document.createElement("div");
    el.className = "txn " + (txn.side === "BUY" ? "buy" : "sell");
    if (opts.victim)
        el.classList.add("victim");
    if (opts.template)
        el.classList.add("template");
    el.dataset.id = txn.id;
    const action = document.createElement("div");
    action.className = "action";
    action.textContent = `${txn.side === "BUY" ? "Buy" : "Sell"} ${txn.asset}`;
    const amt = document.createElement("div");
    amt.className = "amt";
    amt.textContent = `${txn.qty} ${txn.asset}`;
    const owner = document.createElement("div");
    owner.className = "owner";
    owner.textContent = opts.template ? "you (drag to add)" : txn.owner;
    el.append(action, amt, owner);
    return el;
}
// Read the current block order straight from the DOM and resolve to Txns.
function readBlock(blockArea) {
    const out = [];
    for (const child of Array.from(blockArea.children)) {
        const id = child.dataset.id;
        if (id && txnById.has(id))
            out.push(txnById.get(id));
    }
    return out;
}
// ---------------------------------------------------------------------
// Graph: price over the block. X positions line up EXACTLY with the
// transaction boxes below by measuring each box's on-screen center.
// ---------------------------------------------------------------------
const graph = document.getElementById("graph");
const graphWrap = document.getElementById("graph-wrap");
const blockArea = document.getElementById("block-area");
function drawGraph(level) {
    const ctx = graph.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = graphWrap.clientWidth;
    const cssH = graphWrap.clientHeight;
    graph.width = Math.round(cssW * dpr);
    graph.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const block = readBlock(blockArea);
    const { start, points } = simulate(level, block);
    // ----- Y scale: fit all prices with a little headroom -----
    const allPrices = [start, ...points.map((p) => p.price)];
    const pMin = Math.min(...allPrices);
    const pMax = Math.max(...allPrices);
    const pad = Math.max(2, (pMax - pMin) * 0.15);
    const lo = Math.max(0, pMin - pad);
    const hi = pMax + pad;
    const padL = 44, padR = 12, padT = 10, padB = 14;
    const plotH = cssH - padT - padB;
    const yOf = (price) => padT + plotH * (1 - (price - lo) / (hi - lo || 1));
    // ----- X positions: measured from the actual transaction boxes so the
    // graph lines up EXACTLY with each box's horizontal center. -----
    const wrapRect = graphWrap.getBoundingClientRect();
    const boxes = Array.from(blockArea.children);
    const xOfIndex = (i) => {
        // index -1 = the "start" point (before any txn), pinned to the left edge.
        if (i < 0 || boxes.length === 0)
            return padL;
        const r = boxes[i].getBoundingClientRect();
        return r.left + r.width / 2 - wrapRect.left;
    };
    // ----- gridlines: light Y guides + labels -----
    ctx.strokeStyle = "#2a3242";
    ctx.fillStyle = "#8b949e";
    ctx.lineWidth = 1;
    ctx.font = "11px ui-sans-serif, system-ui";
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
        const price = lo + ((hi - lo) * t) / ticks;
        const y = yOf(price);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(cssW - padR, y);
        ctx.stroke();
        ctx.fillText(price.toFixed(0), 6, y + 4);
    }
    // ----- vertical guide under each transaction box -----
    ctx.strokeStyle = "rgba(88,166,255,0.15)";
    for (let i = 0; i < boxes.length; i++) {
        const x = xOfIndex(i);
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, cssH - padB);
        ctx.stroke();
    }
    // ----- the price line (starts at the pre-block price, steps per txn) -----
    ctx.strokeStyle = "#58a6ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xOfIndex(-1), yOf(start));
    for (let i = 0; i < points.length; i++) {
        ctx.lineTo(xOfIndex(i), yOf(points[i].price));
    }
    ctx.stroke();
    // ----- dots at each transaction's resulting price -----
    ctx.fillStyle = "#58a6ff";
    const drawDot = (x, y) => {
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
    };
    drawDot(xOfIndex(-1), yOf(start));
    for (let i = 0; i < points.length; i++)
        drawDot(xOfIndex(i), yOf(points[i].price));
}
// ---------------------------------------------------------------------
// Wire up: build level, populate mempool + palette, enable dragging.
// ---------------------------------------------------------------------
function buildPaletteTemplates(level) {
    const palette = document.getElementById("palette");
    palette.innerHTML = "";
    for (const side of level.allowed) {
        // A template is a stand-in; each drag CLONES a fresh transaction.
        const template = { id: newId("tpl"), owner: "PLAYER", side, asset: "DOGE", qty: 10 };
        const el = txnEl(template, { template: true });
        palette.appendChild(el);
    }
}
function buildMempool(level) {
    const mempool = document.getElementById("mempool");
    mempool.innerHTML = "";
    for (const v of level.victims) {
        txnById.set(v.id, v);
        mempool.appendChild(txnEl(v, { victim: true }));
    }
}
function setupDragging(level) {
    const mempool = document.getElementById("mempool");
    const palette = document.getElementById("palette");
    const onChange = () => drawGraph(level);
    // Block: the ordered list the player submits.
    Sortable.create(blockArea, {
        group: { name: "txns", pull: true, put: true },
        animation: 150,
        forceFallback: true,
        onSort: onChange,
        // When an item is dropped in from the palette it's a template clone;
        // turn it into a real, uniquely-identified PLAYER transaction.
        onAdd: (evt) => {
            if (evt.from === palette) {
                const el = evt.item;
                const side = el.classList.contains("buy") ? "BUY" : "SELL";
                const txn = { id: newId("p"), owner: "PLAYER", side, asset: "DOGE", qty: 10 };
                el.dataset.id = txn.id;
                el.classList.remove("template");
                const owner = el.querySelector(".owner");
                if (owner)
                    owner.textContent = "PLAYER";
                txnById.set(txn.id, txn);
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
    // Palette: a source of templates. pull:'clone' leaves a fresh copy behind
    // so the palette stays populated; the travelling node becomes a real Txn
    // in the block's onAdd handler above.
    Sortable.create(palette, {
        group: { name: "txns", pull: "clone", put: false },
        sort: false,
        animation: 150,
        forceFallback: true,
    });
}
function main() {
    const level = LEVEL_1;
    buildPaletteTemplates(level);
    buildMempool(level);
    setupDragging(level);
    drawGraph(level);
    window.addEventListener("resize", () => drawGraph(level));
}
main();
//# sourceMappingURL=app.js.map