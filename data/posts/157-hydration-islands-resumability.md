---
title: "Hydration in Depth: Full, Progressive, Selective, Islands and Resumability"
tag: javascript
description: What hydration actually does after server-side rendering and why it costs so much — the double-render problem, hydration mismatches and how React, Vue and Solid detect them, React 18 selective hydration and event replay, progressive and lazy hydration in Vue 3.5 and Angular's incremental hydration, the islands architecture in Astro, resumability in Qwik, how React Server Components change the picture, and a runnable model that counts the work each strategy does
date: "2026-11-12T14:30:00.000Z"
---

## Goal

Server-side rendering (SSR) gives the browser real HTML, so text and images can paint before any JavaScript arrives. But SSR HTML is inert: buttons do nothing until the framework "hydrates" the page. For many sites the period between "looks ready" and "is ready" is the single worst part of the user experience, and most of the innovation in frontend frameworks over the last five years — streaming, Suspense, islands, server components, resumability — is about shrinking that window.

This article covers:

1. What hydration does, step by step, and why it repeats work the server already did.
2. Hydration mismatches: where they come from, how frameworks detect them, and how to avoid them.
3. React 18 selective hydration and event replay.
4. Progressive and lazy hydration (Vue 3.5, Angular incremental hydration).
5. The islands architecture (Astro, Fresh, Marko).
6. Resumability (Qwik) and what it trades away.
7. Where React Server Components fit.
8. A small runnable model that counts the work each strategy performs.
9. A decision guide.

## 1. What hydration actually does

A typical SSR request goes through these stages:

1. The server runs the component tree, produces an HTML string, and usually serializes the data it used (for example a `<script>` tag with JSON, or Next.js's flight payload).
2. The browser parses the HTML and paints. The page *looks* finished.
3. The browser downloads, parses and compiles the JavaScript bundle for the whole route.
4. The framework runs the **entire component tree again** on the client, using the serialized data, to rebuild its internal model (virtual DOM, fiber tree, reactive graph, component instances).
5. It walks that model and the existing DOM **in lockstep**, claiming each existing DOM node instead of creating a new one, and attaching event listeners, refs and effects.
6. Effects run; the page is now interactive.

Steps 3–5 are hydration. The key observation is that step 4 repeats the server's rendering work: the client re-executes every component, even the ones that will never change, only to rediscover state the server already knew. This is why hydration cost scales with **page size**, not with **how interactive the page is**. A 5,000-word article with one "like" button pays for rendering all 5,000 words twice.

Concretely, in React:

```jsx
// server
import { renderToPipeableStream } from 'react-dom/server';
renderToPipeableStream(<App data={data} />, { bootstrapScripts: ['/main.js'] }).pipe(res);

// client (main.js)
import { hydrateRoot } from 'react-dom/client';
hydrateRoot(document.getElementById('root'), <App data={window.__DATA__} />);
```

And in Vue:

```js
// client
import { createSSRApp } from 'vue';
const app = createSSRApp(App);
app.mount('#app'); // detects server-rendered markup and hydrates instead of re-creating
```

The time between first paint and the end of hydration is sometimes called the "uncanny valley": the page responds to scrolling (that's the browser) but not to clicks (that needs the framework). It shows up in field metrics as poor **Interaction to Next Paint (INP)** and in lab metrics as **Total Blocking Time**, because hydration of a large tree is one long main-thread task unless the framework breaks it up.

## 2. Hydration mismatches

Hydration assumes the client render produces exactly the same markup as the server render. When it doesn't, the framework has three options: patch the difference, throw away the subtree and render it fresh on the client, or keep the wrong DOM. Typical causes:

- **Time and randomness**: `new Date()`, `Math.random()`, `crypto.randomUUID()` during render.
- **Environment checks**: `typeof window !== 'undefined'` branches, `localStorage`, viewport width, user-agent sniffing.
- **Locale and time zone**: `toLocaleString()` on a server in UTC versus a browser in UTC+8.
- **Invalid HTML nesting**: a `<div>` inside a `<p>`, or a `<tr>` directly inside `<table>` without `<tbody>`. The HTML parser silently "fixes" the tree, so the DOM no longer matches what the framework rendered.
- **Browser extensions and proxies** injecting attributes or nodes before hydration runs.
- **Non-deterministic IDs**: an incrementing counter shared across requests on the server.

How frameworks respond:

- **React 18+**: in a concurrent root, a mismatch makes React discard the server HTML up to the nearest `<Suspense>` boundary and client-render that subtree, reporting it through `onRecoverableError`. If there is no boundary it falls back to client-rendering the whole root. React 19 improved the dev-mode message to show a diff of the mismatched content. `suppressHydrationWarning` silences a single element's text or attribute mismatch, which is the intended escape hatch for timestamps.
- **Vue 3**: logs a hydration mismatch warning in development and patches the DOM to match the client. Vue 3.5 added the `data-allow-mismatch` attribute (optionally scoped to `text`, `children`, `class`, `style` or `attribute`) for expected differences.
- **Solid**: tags server-rendered elements with hydration keys (`data-hk`) and claims nodes by key, so a mismatch generally surfaces as a missing-node error rather than a silent patch.

Patterns that avoid mismatches:

```jsx
// 1. Stable IDs across server and client (React 18+)
const id = useId();
<label htmlFor={id}>Email</label><input id={id} />

// 2. Client-only values: render the server value first, update after hydration
function LocalTime({ iso }) {
  const [text, setText] = useState(iso);           // identical on both sides
  useEffect(() => setText(new Date(iso).toLocaleString()), [iso]);
  return <time dateTime={iso}>{text}</time>;
}

// 3. External stores: give React an explicit server snapshot
const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
```

Pattern 2 costs one extra render, but it makes the hydration pass deterministic. The principle is simple: **everything that affects the first client render must come from serialized server data**, never from the client environment.

## 3. React 18: streaming, selective hydration and event replay

Before React 18, hydration was all-or-nothing: the client had to download all code for the page and hydrate the whole tree in one synchronous pass. React 18 changed three things at once.

**Streaming HTML.** With `renderToPipeableStream` (Node) or `renderToReadableStream` (web streams), the server sends the shell immediately and streams each `<Suspense>` boundary's content when its data resolves, as hidden HTML plus a small inline script that swaps it into place.

**Selective hydration.** Each `<Suspense>` boundary becomes an independent hydration unit. If its code (via `React.lazy`) or HTML hasn't arrived yet, React hydrates everything else and comes back later. Hydration also runs in the concurrent scheduler, yielding to the browser between units of work instead of blocking for the whole tree.

**Prioritization and event replay.** If the user clicks inside a boundary that hasn't hydrated yet, React records the event, raises that boundary's priority, hydrates it synchronously ahead of the others, and then replays the discrete event against the now-hydrated component. Clicks during hydration are no longer lost, which is a direct INP improvement.

```jsx
<Layout>
  <Nav />
  <Suspense fallback={<Spinner />}>
    <Comments />          {/* can hydrate independently, and first if clicked */}
  </Suspense>
  <Suspense fallback={<Spinner />}>
    <Recommendations />
  </Suspense>
</Layout>
```

What selective hydration does **not** change: every component still ships its code to the client and still re-renders during hydration. It changes the *order and granularity* of the work, not the *amount*.

## 4. Progressive and lazy hydration

Progressive hydration goes one step further: some subtrees are not hydrated at all until a trigger — becoming visible, the browser going idle, a media query matching, or a first interaction. The HTML is already on screen; only the JavaScript and the hydration walk are deferred.

**Vue 3.5** exposes this through async components:

```js
import { defineAsyncComponent, hydrateOnVisible, hydrateOnIdle, hydrateOnInteraction } from 'vue';

const Comments = defineAsyncComponent({
  loader: () => import('./Comments.vue'),
  hydrate: hydrateOnVisible({ rootMargin: '200px' }),
});
const Chat = defineAsyncComponent({
  loader: () => import('./Chat.vue'),
  hydrate: hydrateOnInteraction(['click', 'focus']),
});
```

**Angular** builds it on deferrable views. With incremental hydration enabled (`provideClientHydration(withIncrementalHydration())`, developer preview in Angular 19 and stable in Angular 20), a `@defer` block can declare hydration triggers, and Angular's event replay — the `jsaction` mechanism inherited from Google's internal Wiz framework — captures events that hit dehydrated regions and replays them after the block hydrates:

```html
@defer (hydrate on viewport) {
  <product-reviews [id]="productId" />
}
@defer (hydrate on interaction) {
  <size-picker />
}
@defer (hydrate never) {
  <legal-footer />   <!-- stays static HTML forever -->
}
```

The trade-off with progressive hydration is the **first interaction** on a dehydrated region: code has to be fetched and the subtree hydrated before the handler can run. Frameworks mitigate this by prefetching on idle or hover, and by replaying the event rather than dropping it. Also, a deferred subtree still lives *inside* the application's component tree, so its parents' code is still shipped and hydrated.

## 5. Islands architecture

The islands idea flips the default. The page is static HTML; only explicitly marked components ship JavaScript and hydrate, each as an independent mini-application with its own root. The term was coined by Katie Sylor-Miller at Etsy and popularized by Jason Miller's 2020 article "Islands Architecture".

In **Astro**, components render to HTML with zero JavaScript unless given a client directive:

```astro
---
import Header from '../components/Header.astro';   // static, no JS
import Search from '../components/Search.jsx';
import Cart from '../components/Cart.vue';
import Chart from '../components/Chart.svelte';
---
<Header />
<Search client:load />                      <!-- hydrate immediately -->
<Cart client:idle />                        <!-- after requestIdleCallback -->
<Chart client:visible />                    <!-- when it scrolls into view -->
<MobileMenu client:media="(max-width: 768px)" />
<Map client:only="react" />                 <!-- skip SSR, render only on client -->
```

Each island is rendered inside an `<astro-island>` custom element that carries its serialized props and the URL of its component chunk; when its trigger fires, it imports the framework renderer and hydrates just that subtree. Astro 5 added **server islands** (`server:defer`), which apply the same idea in the other direction: a personalized fragment is rendered later on the server and streamed in, so the rest of the page can be cached.

Other implementations: **Fresh** (Deno, Preact) treats components in an `islands/` directory as interactive; **Marko** (eBay) has done automatic partial hydration since Marko 4, using the compiler to decide which components need client code.

Strengths of islands:

- JavaScript cost scales with the **number and size of islands**, not with the page.
- Islands are isolated; a slow chart cannot block the search box.
- Different islands can even use different frameworks.

Costs:

- **Shared state between islands** is no longer free. Components in different islands do not share a React context or Vue `provide/inject`; you need a framework-agnostic store (Nano Stores is the common choice in Astro), custom events, or URL state.
- **Client-side navigation** is harder: by default a link is a full page load. Astro's View Transitions / `<ClientRouter />` softens this, but highly app-like experiences (dashboards, editors) fight the model.
- Props crossing the island boundary must be **serializable**: no functions, class instances or circular structures.

Islands work best for content-heavy pages with a handful of interactive widgets: docs, blogs, marketing sites, e-commerce product pages.

## 6. Resumability

Every approach so far still *executes components on the client* to rebuild state. **Resumability**, as implemented by Qwik, aims to skip that step entirely. The server serializes not only data but the framework's own state: component boundaries, reactive subscriptions, and references to event handlers. The client then "resumes" from that snapshot instead of replaying the render.

The mechanics:

- The Qwik optimizer splits code at every `$` boundary (`component$`, `onClick$`, `useTask$`...), turning each closure into a separately importable symbol.
- The server emits HTML where listeners are attributes pointing at those symbols, roughly `on:click="q-chunk.js#Counter_onClick_xyz"`, plus a JSON blob of application state.
- A tiny global script (the **qwikloader**, around 1 KB) registers a single listener per event type on the document. On a click it walks up from the target, finds the `on:click` attribute, imports that one chunk, deserializes the state the handler captured, and runs it.

```tsx
import { component$, useSignal } from '@builder.io/qwik';

export const Counter = component$(() => {
  const count = useSignal(0);
  return <button onClick$={() => count.value++}>count: {count.value}</button>;
});
```

At page load there is effectively no framework work: no tree walk, no component execution. Code for a handler loads only when that interaction happens, and Qwik prefetches likely chunks (via a service worker or modulepreload) so the first click doesn't wait on the network.

Trade-offs:

- **Everything captured by a `$` closure must be serializable.** This is the same constraint as island props, but applied everywhere, and it shapes how you write components.
- **First-interaction latency** depends on prefetching working well; on a cold cache with a slow network, the first click pays for a fetch.
- **Serialized state adds HTML weight.**
- A smaller ecosystem than React or Vue, and a mental model that takes adjustment.

## 7. Where React Server Components fit

React Server Components (RSC) attack the problem from a different angle: instead of making hydration cheaper, they **remove components from the hydration set**. A Server Component runs only on the server; its code is never sent to the client and it is never hydrated. Only components marked `'use client'` (and everything they import) are in the client bundle and get hydrated.

```tsx
// app/post/[slug]/page.tsx — Server Component: no client JS
export default async function Post({ params }) {
  const post = await db.post.find(params.slug);
  return (
    <article>
      <Markdown source={post.body} />     {/* heavy parser stays on the server */}
      <LikeButton postId={post.id} />     {/* the only hydrated part */}
    </article>
  );
}

// LikeButton.tsx
'use client';
export function LikeButton({ postId }) { /* useState, onClick ... */ }
```

In effect this gives you islands *inside* a single React tree: client components are islands, server components are the static sea, and unlike classic islands, they can still share context from a client provider placed above them, and client-side navigation works by fetching a new RSC payload. The cost is real complexity: the `'use client'` boundary is easy to place too high (dragging large subtrees into the bundle), props across it must be serializable, and the RSC payload is sent in addition to the HTML.

## 8. A runnable model of the work

To make the differences concrete, here is a small model in plain Node.js. The "page" is an article with 200 paragraphs plus two interactive counter buttons. The server renders it to a DOM-like tree; then we make it interactive three ways and count how many nodes each strategy touches at load time.

```js
const h = (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat() });

function Counter({ id, start }) {
  return h('button', { id, onClick: s => s.count++, 'data-island': 'Counter' }, `count: ${start}`);
}
function App({ now }) {
  const paras = Array.from({ length: 200 }, (_, i) => h('p', null, `paragraph ${i}`));
  return h('main', null,
    h('header', null, h('h1', null, 'Hydration'), h('time', null, now)),
    h('article', null, ...paras),
    Counter({ id: 'a', start: 0 }),
    Counter({ id: 'b', start: 5 }));
}

// Server output as the browser would parse it: no listeners, just markup.
const toDom = v => typeof v === 'string'
  ? { text: v }
  : { tag: v.tag, attrs: Object.fromEntries(Object.entries(v.props).filter(([k]) => !k.startsWith('on'))),
      children: v.children.map(toDom), listeners: {} };

// 1. Full hydration: re-run the whole tree, walk vnode and DOM in lockstep.
function hydrate(vnode, dom, stats) {
  stats.visited++;
  if (typeof vnode === 'string') {
    if (dom.text !== vnode) stats.mismatches.push(`text "${dom.text}" vs "${vnode}"`);
    return;
  }
  if (dom.tag !== vnode.tag) { stats.mismatches.push(`tag ${dom.tag} vs ${vnode.tag}`); return; }
  for (const [k, fn] of Object.entries(vnode.props))
    if (k.startsWith('on')) { dom.listeners[k] = fn; stats.listeners++; }
  vnode.children.forEach((c, i) => hydrate(c, dom.children[i], stats));
}

// 2. Islands: hydrate only marked subtrees, each from its own serialized props.
function hydrateIslands(dom, registry, stats) {
  const walk = node => {
    if (node.attrs?.['data-island']) {
      const start = Number(node.children[0].text.split(': ')[1]);
      hydrate(registry[node.attrs['data-island']]({ id: node.attrs.id, start }), node, stats);
      return;
    }
    node.children?.forEach(walk); // real frameworks locate islands without a full scan
  };
  walk(dom);
}

// 3. Resumability: nothing runs at load; a global dispatcher resolves the handler lazily.
function resume(dom, stats, lazyImport) {
  return targetId => {
    const find = n => n.attrs?.id === targetId ? n : n.children?.map(find).find(Boolean);
    const handler = lazyImport(find(dom).attrs['data-island']);
    stats.loadedOnDemand++;
    return handler;
  };
}
```

Running it (Node.js 24) prints:

```text
full hydration      : { visited: 411, listeners: 2, mismatches: 0 }
full, clock mismatch: {
  visited: 411,
  mismatches: [ 'text "2026-11-12T14:00:00Z" vs "2026-11-12T14:00:07Z"' ]
}
islands             : { visited: 4, listeners: 2, mismatches: 0 }
resumable at load   : { loadedOnDemand: 0 }
resumable after click: { loadedOnDemand: 1 }
```

The numbers are from this toy, not a benchmark of any framework, but the shape is the point:

- Full hydration touches all 411 nodes (the 200 paragraphs and their text nodes dominate) to attach **2** listeners.
- When the client renders the timestamp seven seconds later than the server did, the walk finds a text mismatch — exactly the `new Date()` bug from section 2.
- Islands touch 4 nodes: two buttons and their text. Work is proportional to interactivity.
- Resumability touches nothing at load and loads one handler when the user actually clicks.

## 9. Comparison and decision guide

| Strategy | Client JS shipped | Load-time work | First interaction | Typical tools |
| --- | --- | --- | --- | --- |
| Full hydration | Whole route | Re-render whole tree | Fast once hydrated; dropped or delayed before | Classic SSR in React/Vue/Svelte |
| Selective (React 18) | Whole route, split per boundary | Whole tree, chunked and prioritized | Clicked boundary hydrates first, event replayed | Next.js, Remix/React Router |
| Progressive / lazy | Deferred per subtree | Only hydrated subtrees | Fetch + hydrate on trigger, event replayed | Vue 3.5, Angular `@defer` |
| Islands | Only islands | Only islands | Fast inside islands; none outside | Astro, Fresh, Marko |
| Server Components | Only client components | Only client components | Normal React | Next.js App Router |
| Resumability | Per handler, on demand | Near zero | Lazy load of one handler (prefetched) | Qwik |

Practical guidance:

- **Content-first site** (docs, blog, marketing, product pages): islands or RSC. Most of the page should never hydrate.
- **Highly interactive app behind a login** (dashboards, editors): SSR matters less; a client-rendered SPA or full hydration with good code splitting is often simpler and fine.
- **Large existing React app**: adopt streaming plus `<Suspense>` boundaries around independent regions to get selective hydration, then move non-interactive parts to Server Components and push `'use client'` boundaries down toward the leaves.
- **Existing Vue or Angular app**: lazy hydration (`hydrateOnVisible`, `@defer (hydrate on viewport)`) for below-the-fold regions is a low-risk win.
- **Extreme time-to-interactive requirements on large pages**: resumability is worth evaluating, accepting the serialization constraints.

Whatever the strategy:

- Keep the first client render deterministic; move time, randomness and environment checks into effects.
- Validate HTML nesting — parser fix-ups are a silent source of mismatches.
- Measure INP and Total Blocking Time on mid-range mobile hardware, and look at hydration tasks in the Performance panel rather than assuming.
- Watch serialized payload size; hydration data embedded in HTML can quietly exceed the markup itself.

## References

- [React — hydrateRoot](https://react.dev/reference/react-dom/client/hydrateRoot)
- [React 18 working group — New Suspense SSR architecture](https://github.com/reactwg/react-18/discussions/37)
- [React — useId](https://react.dev/reference/react/useId)
- [React — Server Components](https://react.dev/reference/rsc/server-components)
- [Vue — SSR guide, hydration mismatch](https://vuejs.org/guide/scaling-up/ssr.html#hydration-mismatch)
- [Vue — Lazy hydration for async components](https://vuejs.org/guide/components/async.html#lazy-hydration)
- [Angular — Incremental hydration](https://angular.dev/guide/incremental-hydration)
- [Astro — Islands architecture](https://docs.astro.build/en/concepts/islands/)
- [Astro — Template directives (client:*)](https://docs.astro.build/en/reference/directives-reference/)
- [Qwik — Resumable vs. hydration](https://qwik.dev/docs/concepts/resumable/)
- Jason Miller, [Islands Architecture](https://jasonformat.com/islands-architecture/)
- [web.dev — Rendering on the Web](https://web.dev/articles/rendering-on-the-web)
- [web.dev — Interaction to Next Paint](https://web.dev/articles/inp)
