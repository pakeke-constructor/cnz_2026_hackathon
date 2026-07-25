# SortableJS Reference (for LLM context)

SortableJS reorders **real DOM children** within a container and fires events telling you the new order. It does NOT own your data model or styling — mirror its events into your own state array; don't re-render the list from state on every tick or you'll fight it.

- CDN: `<script src="https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js"></script>`
- Repo/docs: https://github.com/SortableJS/Sortable

## Quick start

```js
const list = document.getElementById('block-area');
const sortable = Sortable.create(list, {
  group: 'txns',          // shared name lets lists exchange items
  animation: 150,
  forceFallback: true,    // use JS pointer dragging (smoother, controllable) instead of native HTML5 DnD
  onEnd(evt) {
    // sync your state from evt.oldIndex / evt.newIndex / evt.from / evt.to
  },
});
```

## Constructor options

```js
new Sortable(el, {
  group: "name",  // or { name, pull: [true|false|'clone'|array|fn], put: [true|false|array|fn], revertClone }
  sort: true,                 // allow sorting inside this list
  delay: 0,                   // ms before drag starts
  delayOnTouchOnly: false,    // only apply delay for touch input
  touchStartThreshold: 0,     // px tolerance before cancelling a delayed drag
  disabled: false,            // disable this sortable
  store: null,                // { get(sortable), set(sortable) } persistence hooks
  animation: 150,             // ms move animation
  easing: "cubic-bezier(1, 0, 0, 1)",
  handle: ".my-handle",       // only this selector inside an item starts a drag
  filter: ".ignore",          // selectors that must NOT start a drag
  preventOnFilter: true,      // call preventDefault when a filtered el is dragged
  draggable: ".item",         // which children are draggable
  dataIdAttr: 'data-id',      // attribute read by toArray()
  ghostClass: "sortable-ghost",   // class on the drop-placeholder
  chosenClass: "sortable-chosen", // class on the chosen item
  dragClass: "sortable-drag",     // class on the actively dragged item
  swapThreshold: 1,           // 0..1 size of the swap zone
  invertSwap: false,          // always use inverted swap zone
  invertedSwapThreshold: 1,
  direction: 'horizontal',    // 'vertical' | 'horizontal' | fn -> direction
  forceFallback: false,       // ignore native HTML5 DnD, use JS-positioned clone (recommended for games)
  fallbackClass: "sortable-fallback", // class on the cloned fallback element
  fallbackOnBody: false,      // append the fallback clone to <body>
  fallbackTolerance: 0,       // px of movement before a drag registers
  dragoverBubble: false,
  removeCloneOnHide: true,
  emptyInsertThreshold: 5,    // px from an empty list at which an item inserts
  setData(dataTransfer, dragEl) { /* customize native drag image */ },
})
```

### group (cross-list transfer)

```js
group: {
  name: "txns",
  pull: true | false | 'clone' | ["a","b"] | (to, from, dragEl, evt) => {},  // can items leave this list
  put:  true | false | ["a","b"] | (to, from, dragEl, evt) => {},            // can items enter this list
  revertClone: false,  // animate a clone back to origin after a cross-list move
}
```
Use `pull: 'clone'` for a palette/sidebar that spawns copies (e.g. "create a new transaction" source that keeps its templates). Lists with the same `group.name` can exchange items.

## Event callbacks

Fired on the instance whose list changed. All the "same properties as onEnd" events share the Event Object below.

| Callback | When | Notable props |
|---|---|---|
| `onChoose(evt)` | item chosen (mousedown) | `evt.oldIndex` |
| `onUnchoose(evt)` | item unchosen | onEnd props |
| `onStart(evt)` | drag started | `evt.oldIndex` |
| `onEnd(evt)` | drag ended | full Event Object |
| `onAdd(evt)` | item dropped in from another list | onEnd props |
| `onUpdate(evt)` | order changed within this list | onEnd props |
| `onSort(evt)` | any change (add/update/remove) | onEnd props |
| `onRemove(evt)` | item removed into another list | onEnd props |
| `onFilter(evt)` | tried to drag a filtered item | `evt.item` |
| `onMove(evt, originalEvent)` | pointer moves over a target | see below; **return value controls insertion** |
| `onClone(evt)` | a clone is created | `evt.item`, `evt.clone` |
| `onChange(evt)` | dragged item changes position mid-drag | `evt.newIndex` + onEnd props |

### Event Object (onEnd / onAdd / onUpdate / onSort / onRemove / onChange)

```
evt.to            // HTMLElement — destination list
evt.from          // HTMLElement — source list
evt.item          // HTMLElement — the dragged element
evt.clone         // HTMLElement — the clone (when pull:'clone')
evt.oldIndex      // Number|undefined — index in old parent
evt.newIndex      // Number|undefined — index in new parent
evt.oldDraggableIndex // index counting only draggable children
evt.newDraggableIndex
evt.pullMode      // 'clone' | true | false | undefined
```

### onMove — validate/redirect drops and read positions

```js
onMove(evt, originalEvent) {
  evt.dragged;          // dragged HTMLElement
  evt.draggedRect;      // DOMRect {left,top,right,bottom,width,height}
  evt.related;          // HTMLElement currently hovered
  evt.relatedRect;      // DOMRect of that element
  evt.willInsertAfter;  // Boolean — default is to insert after target
  originalEvent.clientX; originalEvent.clientY; // live pointer position

  // return false;  cancel this move (reject the drop — e.g. "swap can't go outside a flash-loan container")
  // return -1;     force insert BEFORE target
  // return  1;     force insert AFTER target
  // return true / void; keep default
}
```

## Instance methods

```js
sortable.option(name [, value])         // get/set an option at runtime
sortable.closest(el [, selector])       // nearest matching ancestor within list, or null
sortable.toArray()                      // -> String[] of each child's data-id
sortable.sort(orderArray, useAnimation) // reorder to match an array of data-ids
sortable.save()                         // persist via the store option
sortable.destroy()                      // tear down completely
```

## Static API

```js
Sortable.create(el [, options]) // -> Sortable instance
Sortable.get(element)           // -> Sortable instance owning this list element
Sortable.active                 // currently active instance
Sortable.dragged                // element being dragged
Sortable.ghost                  // ghost/placeholder element
Sortable.clone                  // clone element
Sortable.mount(...plugins)      // register plugins (MultiDrag, Swap, AutoScroll, OnSpill)
```

## Sortable.utils

```js
Sortable.utils.on(el, event, fn) / off(el, event, fn)
Sortable.utils.css(el)                 // -> all computed styles
Sortable.utils.css(el, prop)           // get one
Sortable.utils.css(el, prop, value)    // set one
Sortable.utils.css(el, {prop: value})  // set many
Sortable.utils.find(ctx, tagName [, iterator])
Sortable.utils.is(el, selector)        // -> Boolean
Sortable.utils.closest(el, selector [, ctx])
Sortable.utils.clone(el)               // deep copy
Sortable.utils.toggleClass(el, name, state)
Sortable.utils.detectDirection(el)     // 'vertical' | 'horizontal'
Sortable.utils.index(el, selector)     // index within parent
Sortable.utils.getChild(el, childNum, options, includeDragEl)
```

## Persistence (store) example

```js
Sortable.create(el, {
  group: "localStorage-example",
  store: {
    get: (sortable) => {
      const order = localStorage.getItem(sortable.options.group.name);
      return order ? order.split('|') : [];
    },
    set: (sortable) => {
      localStorage.setItem(sortable.options.group.name, sortable.toArray().join('|'));
    }
  }
})
```

## Plugins

- Bundled: **AutoScroll**, **OnSpill**.
- Extra (mount separately): **MultiDrag** (select + drag many), **Swap** (swap instead of insert).

## Gotchas for this project

- Prefer `forceFallback: true` for game-like dragging (consistent visuals, works well on touch, avoids native DnD's clunky drag-image API).
- Get global positions of any box anytime with `element.getBoundingClientRect()` (independent of Sortable) — use it to line up the LP-price chart / draw arrows over boxes.
- Overlays/badges on cards are all yours: `position: relative` on the card, `position: absolute` children.
- Use `onMove` returning `false` to enforce rules (valid drop zones, flash-loan containers).
- Let Sortable own DOM order; sync FROM its events into your state. Don't rebuild the list's innerHTML from state during a drag.
