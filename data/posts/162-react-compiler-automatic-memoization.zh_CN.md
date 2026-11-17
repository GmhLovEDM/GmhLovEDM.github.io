---
title: "深入 React Compiler：自动记忆化、HIR 分析，以及它仍然不会做的事"
tag: javascript
description: React Compiler 如何把 Rules of React 变成编译期记忆化——为什么引用相等会让 useMemo 与 useCallback 失效、基于 CFG 的 HIR 与可变性分析、缓存槽位以及早返回之后的条件记忆化、用 "use memo" 与 "use no memo" 渐进接入、它与 signal / React.memo 的差别，以及一个比较朴素、手写与编译器式策略下重渲染次数的可运行模型
date: "2026-11-17T14:50:00.000Z"
---

## 目标

React 的约定很简单：组件是 props、state 和 context 的函数；其中任何一项变化，React 就再调用一次这个函数，并对结果做 diff。这个模型好推理，而且在很长一段时间里也足够快。它同样解释了另一种常见现象：父组件里一次心跳，就能让一份两百张卡片的列表真正跑一遍，尽管这些卡片的 props 一个都没变。这些年来的逃逸口是手工记忆化——`React.memo`、`useMemo`、`useCallback`——而同一类“引用变了”的问题，也年复一年地把这套手工优化抵消掉。

**React Compiler**（内部曾经叫 Forget）是一个构建期的优化编译器，把那层记忆化替你写好。它不是新的运行时，也不是新的响应式模型。它读取你现有的组件和 Hook，判断哪些中间值和 JSX 元素可以复用，然后生成缓存检查：输入没变，就跳过相应的工作。React Compiler 1.0 在 2025 年 10 月 7 日以稳定版发布；它已经在 Meta 的大型应用里用于生产环境，Expo SDK 54 则默认给新项目打开它。

本文会讲到：

1. 为什么重渲染会贵，以及贵的部分往往是*引用相等*，而不是计算本身。
2. 一旦开始手写 `useMemo` 和 `useCallback`，会踩进哪些坑。
3. 编译器到底是什么：一个以 Babel 为前端的流水线，把 AST 降到基于 CFG 的 HIR，并分析数据流与可变性。
4. 缓存槽位，以及 Hook 无法表达的条件记忆化。
5. 如何接入：编译模式、`"use memo"` / `"use no memo"`、lint，以及已有记忆化怎么办。
6. 它和 signal、以及“随手包一层 `memo`”相比，差在哪里。
7. 编译器不会替你做的事。
8. 一个可运行的模型，统计四种策略下的组件工作量。

## 1. 重渲染税，以及为什么记忆化讨论的是引用

当一个组件的 state 变化时，React 会重新调用这个组件，并且*默认还会调用它返回的每一个子组件*。子组件不必自己有变化，只要它是被一个变化了的父组件渲染出来的就够了。于是有两件事会一起发生。

第一，子组件在 render 阶段做的任何工作——过滤列表、合并主题、为了往下传再分配一个新对象——都会再跑一遍。第二，哪怕单个子组件很便宜，一旦变成列表，代价也会被放大：每一行都会分配新的 props 对象和新的闭包，而这些新的引用会让下一层记忆化全部未命中。

这一点常常被低估。`React.memo(FriendCard)` 做的是 props 的浅比较。如果其中一个 prop 是 `onSelect={() => select(friend.id)}`，比较的就是函数引用，而这个引用在父组件每次渲染时都是新的。`memo` 本身没有写错，它只是永远不会命中。React Compiler 官方文档用的几乎就是这个例子：就算把 `handleClick` 包进 `useCallback`，只要 JSX 里仍然写 `onClick={() => handleClick(item)}`，就还是不够。

所以在 React 里，记忆化首先不是在问“这个计算重不重”，而是在问“这个*值*和上次是不是同一个引用”。编译器的工作，就是让那些重要的值——包括 JSX 元素本身——在输入没变时保持同一个引用。

## 2. 手工记忆化，以及它补不上的洞

一份认真记忆化过的列表，通常需要下面这些同时成立：

- 用 `useMemo` 包住过滤 / 排序后的派生数组，否则新的数组引用会让每个子组件失效。
- 用 `useCallback` 包住传给记忆化子组件的处理函数，并且依赖列表本身也得稳定。
- 给子组件加上 `React.memo`，也给那些不该关心父组件其他 state 的外围 UI（徽标、按钮、侧栏）加上。
- 不要在穿过 `memo` 边界的 props 里随手写新的对象或数组字面量。
- 不要“在 `map` 里再包一层箭头函数”——那会在每次渲染、每一行上悄悄分配一个新函数。

Hook 还加了一条结构约束，在你伸手去记忆化时很容易忘掉。**Hook 必须无条件、以相同顺序、在函数顶部调用。** `useMemo` 是 Hook。它不能写在 `if (!items.length) return <Empty />` 的后面。如果一段不平凡的计算天然只属于某一个分支，你要么把它抬到分支之前（于是在用不到它的那条路径上也要付钱），要么就干脆不记忆化。

最后一个洞不是文风问题，而是运行时依赖的规则。一个生成普通 `if` 去检查缓存槽位的编译器不受这条规则约束，它可以只在早返回的某一侧记忆化一个值。1.0 的发布说明把这一点当作一项关键能力：React Compiler 可以记忆化*条件返回之后*的代码，而 `useMemo` / `useCallback` 做不到。

还有一个更安静的洞。`useMemo` 和 `useCallback` 的依赖数组是你自己写的。漏一个依赖，就会复用过期值；写进一个每次渲染都换引用的依赖，就永远不会复用。可选链和数组下标作为依赖，手写时本来就别扭；1.0 在编译器自己的依赖推断里为这两者提供了正式支持。

## 3. 编译器到底是什么

对外的包装是 `babel-plugin-react-compiler`，而且它必须排在 Babel 插件列表的**第一位**，这样才能看到原始源码，而不是其他变换的输出。插件本身很薄。编译器核心与 Babel 解耦：它接收 AST，降到自己的**高层中间表示**（HIR），并把它组织成**控制流图**（CFG），再在这张 HIR 上跑一系列分析与代码生成遍。

这套架构走了很长的路。React 团队第一次探索编译器是 2017 年的 Prepack；Prepack 后来停止了，但那次工作影响了 Hooks 的设计——Hooks 从一开始就为“将来会有一个编译器”留了位置。2021 年，黄玄给出了新版 React Compiler 的第一个原型。那个原型后来被重写。Joe Savona、Sathya Gunasekaran、Mofei Zhang和 Lauren Tan 把架构迁到了基于 CFG 的 HIR 上，精确的数据流分析和有限度的类型推断这才变得可行。之后又经过多次重写，每一次都吃进上一轮的经验。1.0 的公告把这段历史写得很清楚，也强调 1.0 是一个起点，而不是一份冻结的代码生成器。

这些分析遍大致要回答：

1. 哪些函数是组件或 Hook（命名约定、JSX、Hook 调用，再加上 `"use memo"` 指令）？
2. 哪些值流向哪些值？这是普通的数据流问题，包括经过分支、循环、可选链和数组下标。
3. 哪些操作会*写入*，以及它们别名了什么。如果编译器不能证明一个值不会被修改，它就不能复用这个值，因为复用会让后续读取观察到不同的结果。
4. **响应作用域**在哪里——哪些指令应该共享同一个缓存槽位——以及它们的输入是什么？
5. 这个函数是否遵守 [Rules of React](https://react.dev/reference/rules)？如果答案是否定的，安全的选择是不要优化它，并且最好说明原因。

Rules of React 是语义基础，不是文风建议。组件和 Hook 必须是**幂等**的：相同的输入必须得到相同的输出。副作用不属于 render。props、state、传给 Hook 的参数，以及已经传进 JSX 的值，都是**不可变快照**。不要直接调用组件函数，也不要从普通函数、条件，或早返回之后调用 Hook。编译器用校验遍编码这些规则；诊断信息通过 `eslint-plugin-react-hooks` 提供（`recommended` 预设，以及包含编译器规则的当前预设）。一个会修改自己 props、在 render 期间读取 ref，或无法被证明安全的函数会被跳过，而不是“照样优化”。

生成的代码仍然是 React。没有新的组件模型，Fiber 与调和过程也不变。对每一个被记忆化的值，编译器发出一小段缓存检查：如果输入与上次 `===` 相等，就复用旧值；否则计算，再把输入和结果存起来。在 [React Compiler Playground](https://playground.react.dev) 里，它看起来像一组槽位，加上每个作用域一次比较：

```js
function FriendList(t0) {
  const $ = _c(8);
  const friends = t0.friends;
  const query = t0.query;
  let t1;
  if ($[0] !== friends || $[1] !== query) {
    t1 = filterFriends(friends, query);
    $[0] = friends;
    $[1] = query;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  // 后面还有处理函数、JSX 元素和其他作用域的槽位
  return /* 复用 t1 的 JSX */;
}
```

具体的辅助函数名和运行时导入随着编译器的成熟有过调整（如果你的 `target` 是 React 17 或 18，兼容包是 `react-compiler-runtime`；React 19 不需要额外配置）。真正重要的是形状：**对着每个组件的缓存槽位做普通比较**，而不是引入一套新的订阅系统。

正因为槽位只是 `if` 检查，它们可以被放在早返回之后、分支内部，或 `map` 中的某一个元素周围。这就是 1.0 公告强调的“条件记忆化”，也是编译器能修好 `onClick={() => handleClick(item)}` 的原因：它给 *`map` 里的每个元素* 一个自己的槽位，按 `handleClick` 和 `item` 做键。

有两条已经写在文档里的限制，应当按字面接受。编译器只记忆化**组件和 Hook**，不会处理文件里的每一个辅助函数。而且它的记忆化**不在组件之间共享**：如果五个列表用同一组参数调用同一个昂贵的纯函数，你仍然会付五次，除非这个函数在 React 之外自己做了缓存。文档的建议是：先测量，再决定要不要加那层缓存。

## 4. 接入、指令，以及已经写好的记忆化

对 React 19 来说，安装就是一个开发依赖，再把插件放到 Babel 的第一位：

```js
// babel.config.js
module.exports = {
  plugins: [
    'babel-plugin-react-compiler', // 必须放在第一位
    // ...其他插件
  ],
};
```

React 17 和 18 也可以用，需要设置 `target: '17'` 或 `'18'`，并加上 `react-compiler-runtime` 包。Vite、Metro 和 Rsbuild 都支持。Next.js 15.3.1 及之后的版本可以通过 swc 调用编译器——如果你不想把 Babel 重新请回 Next.js 的构建，这就是该走的路径。React 团队也在与 oxc 项目合作，好让未来基于 Rolldown 的 Vite 流水线同样不再需要 Babel。Expo SDK 54 及更新版本默认启用编译器；`create-vite` 和 `create-next-app` 也提供了同样打开它的模板。

[`compilationMode`](https://react.dev/reference/react-compiler/compilationMode) 决定哪些函数是候选。默认是 `'infer'`：产生 JSX 或调用 Hook 的 PascalCase 名称、以 `use` 为前缀的 Hook，以及用 `"use memo"` 标注过的函数。`'annotation'` 只编译用 `"use memo"` 显式加入的函数（或模块）——这是大型代码库上的渐进路径。`'syntax'` 面向 Flow 的 `component` / `hook` 语法。`'all'` 会编译所有顶层函数，不推荐，因为它也会编到并非 React 代码的辅助函数。不论哪种模式，`"use no memo"` 都会跳过一个函数。两条指令都可以写在模块级，并在单个函数上覆盖。

指令是逃逸口，不是主开关。文档的建议是在项目级配置编译器，只在有注释说明原因时使用 `"use no memo"`，并把退出优化当作暂时措施。`gating` 选项会用运行时特性开关包住优化后的函数体，这样可以把编译器先放给一部分用户，而不必维护两份源码。

已经写好的 `useMemo`、`useCallback` 和 `React.memo` 继续有效。编译器的记忆化通常会和你手写的一样精确，或更精确——尤其是在早返回之后——但官方对*新代码*的建议是：把记忆化交给编译器，只有在你需要*控制*而不是需要*记忆化*的时候再伸手写 Hook。`useMemo` 还常见的一个用途，是稳定某个作为 effect 依赖的值，以免因为缓存槽位的分组方式不同而导致 effect 重新执行。对于*已有*的记忆化，1.0 公告的建议是先留着：拿掉它可能会改变编译输出。

最后这一点也是升级时需要小心的原因。未来的编译器版本可能会做得更细。如果一个今天碰巧引用稳定的值，被用作 effect 的依赖，更精确的缓存可能更频繁或更不频繁地重建它，effect 的触发就会不一样。React 团队的立场是，effect 应当用来同步，而不是当作隐式的触发器；真实代码库里，总有一些 effect 并不是这样用的。如果在升级插件时，你没有办法自动发现这类行为变化，就把编译器钉在一个确切版本上，而不要使用 SemVer 范围。

## 5. 对比：编译器、`memo` 和 signal

很容易把 React Compiler 说成“React 的细粒度响应式”。入门文档甚至用这个词来描述结果——只有相关的那一部分树会重新渲染。但机制和 signal 不是一回事，在选型时这个差别很重要。

**signal**（Solid、Vue 的 `ref` / `computed`、Angular 的 `signal`、Preact Signals、Svelte 5 的 rune，以及 TC39 提案）是一张运行时图。在计算中读取一个 signal，就会把这段计算订阅到该 signal 上。signal 写入时，只有被订阅的计算会再跑，而且在细粒度系统里，这些计算常常直接更新一个 DOM 节点。这里没有“父函数跑了，所以子函数也跑了”这一步。本系列先前有一篇文章，较仔细地讲过推拉算法、菱形闪烁和染色。

**React Compiler 并不改运行时模型。** 一个被编译过的 `FriendList`，仍然会在它的 state 或 Hook 认为该更新时运行。编译器改变的是*函数体*：过滤、处理函数，以及子组件的 JSX 都可以复用，于是 `FriendCard` 根本不会被调用，Fiber 对这个子节点也没有新的东西要对。你仍然有组件树、render 阶段和一次 diff，只是这三步都少做了很多。

和**手工 `React.memo`** 相比，编译器赢在完整，以及 Hook 表达不了的那些情况：

- 它记忆化中间值，而不只是组件边界。
- 它为 `map` 里的每个元素闭包分别记忆化。
- 它可以在早返回之后记忆化。
- 它自己推断依赖，包括可选链和数组下标，而不是信任你维护的那份数组。
- 当 Rules of React 被打破时，它会*拒绝*记忆化，这比你写在一次修改外面的 `useMemo` 更安全。

和 **signal** 相比，编译器赢在迁移成本——现有的 React，包括 React Native，不必重写——但在工作量的下限上会让步。如果父组件因为调用了 `useFriendOnlineCount()` 而必须再执行，父函数仍然会跑，即便每一个 JSX 槽位都命中了。以 signal 实现的徽标，根本不会让列表函数参与进来。第 8 节的模型把这一点表现得很清楚：在每一种策略下，`FriendList` 都运行了 37 次，编译器也不例外。真正省下的，是这个函数*下面*的所有东西。

Svelte 5 和 Solid 也会编译，但它们编译*进*另一套运行时（细粒度订阅、直接更新）。React Compiler 编译*进*更好的 React。概念上这是更小的一跳，它同时也是天花板：你不会从这个编译器里得到 Solid 那种按节点更新。

## 6. 它不会做的事

列一份短清单，免得把错事怪到编译器头上：

- **它不会跳过一个读到了变化 state 或变化 Hook 的组件。** 如果某个更新里你不希望父组件做那些工作，就把 Hook 放到更小的子组件里。
- **它不会记忆化非组件的辅助函数**，也不会在组件之间共享记忆化。一个在许多地方用到的、真正昂贵的纯函数，仍然需要自己的缓存。
- **它不会修好对 Rules of React 的违反。** 它会跳过这个函数，并且在配合 ESLint 插件时告诉你原因。修改 props、在值已经传进 JSX 之后再改它、在 render 期间读写 ref，或有条件地调用 Hook，都会让你离开那条顺利的路径。
- **它不会让一次沉重的提交变便宜。** 布局、绘制、effect 和网络都不在它的范围内。本系列先前关于浏览器渲染管线，以及关于 hydration 的文章，讨论的是那些代价。
- **它不会专门为 effect 稳定一个值，除非碰巧如此。** 如果一个 effect 的正确性依赖于某个特定引用，就显式使用 `useMemo` / `useCallback`；更好的做法，是不要把引用相等当成 render 和 effect 之间的协议。
- **它不会取代 Server Components、islands 或可恢复性。** 那些方案减少的是一开始有多少代码在客户端运行。编译器让*已经会运行*的代码在*更新*时更便宜。它们是互补的，不是替代关系。

在生产环境里，通常应该先打开 lint 预设，而不是先打开编译插件。一份已经遵守 Rules of React 的代码，往往会顺利编译。一份没有遵守的代码会告诉你原因，而 `"use no memo"` 加上 `compilationMode: 'annotation'`，允许你一次只接入一座岛屿。

## 7. 一个可运行的模型

下面的程序并不是编译器。它是一个计数器，用来衡量每种策略*想要避免*的工作。这棵树是一个包含 200 个好友的 `FriendList`：由 Hook 驱动的 `OnlineBadge`、一次昂贵的 `filter`、一个没有任何输入的 `MessageButton`、每个可见好友一张 `FriendCard`，以及一个 `merge_theme` 辅助函数——在非空路径上，它运行在早返回*之后*，而 Hook 在那里是不合法的。

四种策略：

- **naive。** 父组件一跑，每个子组件都跑。没有任何记忆化。
- **manual_broken。** `FriendCard` 包了 `memo`，但父组件在每次渲染、每一张卡片上都会传入新的 `on_select` 闭包。`memo` 永远不会命中。过滤、主题、徽标和按钮也都没有记忆化。这就是“我们加了 `memo`，却一点都没有变快”的配置。
- **manual_correct。** 用 `useMemo` 包过滤，用一个稳定的 `useCallback` 做 `on_select`，给 `FriendCard`、`MessageButton` 和 `OnlineBadge` 加上 `React.memo`。`merge_theme` *没有*被记忆化，因为它在早返回之后。
- **compiler。** 用引用比较的缓存槽位覆盖过滤、稳定的处理函数、每张卡片的 props（包括稳定的处理函数）、外围 UI，以及分支两侧的 `merge_theme`。

场景一共 37 次更新：一次初始渲染，八次查询更新（最后两次匹配不到任何人，于是树切换到 `NoFriends`），一次清空查询从而重新挂载列表，五次选中，二十次 `online_count` 跳动，一次重命名（替换一个好友对象），以及一次主题标记的变化。卸载子组件会丢掉它的记忆化状态，所以重新挂载要付全价。

在 CPython 3 上的输出：

```text
Steps: 37  Friends: 200

== naive ==
FriendList=37  FriendCard=5969  OnlineBadge=37  MessageButton=35  NoFriends=2  filter=37  merge_theme=37

== manual_broken ==
FriendList=37  FriendCard=5969  OnlineBadge=37  MessageButton=35  NoFriends=2  filter=37  merge_theme=37

== manual_correct ==
FriendList=37  FriendCard=410  OnlineBadge=21  MessageButton=2  NoFriends=1  filter=11  merge_theme=37

== compiler ==
FriendList=37  FriendCard=410  OnlineBadge=21  MessageButton=2  NoFriends=1  filter=11  merge_theme=3

== phase totals (FriendCard / filter / merge_theme / FriendList) ==
initial                                   200/1/1/1        200/1/1/1        200/1/1/1        200/1/1/1
8 query keystrokes (last empty)           169/8/8/8        169/8/8/8          0/8/8/8          0/8/1/8
query cleared                             200/1/1/1        200/1/1/1        200/1/1/1        200/1/0/1
5 selections                             1000/5/5/5       1000/5/5/5          9/0/5/5          9/0/0/5
20 online-count ticks                 4000/20/20/20    4000/20/20/20        0/0/20/20         0/0/0/20
rename friend 0                           200/1/1/1        200/1/1/1          1/1/1/1          1/1/0/1
theme token change                        200/1/1/1        200/1/1/1          0/0/1/1          0/0/1/1

Cell format: FriendCard / filter / merge_theme / FriendList
```

怎么读这些数字：

1. **写坏的手工记忆化和什么都不做无法区分。** `manual_broken` 和 `naive` 都让 `FriendCard` 执行了 5,969 次。父组件每次渲染时一个新的 `on_select` 引用，就足以彻底打败 `React.memo`。在二十次在线人数跳动里，朴素和写坏的策略各自把卡片函数跑了 4,000 次；写对的策略和编译器是 0 次。

2. **写对的手工记忆化和编译器，在组件树上是一致的。** 两者都让 `FriendCard` 运行 410 次：挂载 200，空查询之后重新挂载再 200（子组件卸载时记忆化状态会丢掉），五次选中是 9 次（第一次选中绘制一张卡片，之后每次变更绘制两张），以及好友 0 被替换时的 1 次。两者都让 `filter` 运行 11 次——只在 `friends` 或 `query` 变化时，选中、跳动和主题变化都不会触发。两者都让 `MessageButton` 运行 2 次（挂载和重新挂载），让 `OnlineBadge` 运行 21 次（挂载加上二十次跳动）。如果你已经把记忆化写到这个程度，编译器并不是同一棵树上更快的算法。它是一种不必再写、也不必再维护这套记忆化，却能得到这棵树的方法。

3. **编译器多出来的胜负手，是后置的 `merge_theme`。** `manual_correct` 仍然调用它 37 次，每次父组件渲染一次，因为 `useMemo` 不能合法地放在早返回之后。编译器在分支两侧各留一个槽位，只调用 3 次：非空路径上第一次，列表第一次变空时，以及主题标记真正变化时。二十次跳动里，`manual_correct` 付了 20 次主题合并，编译器付了 0 次。在这个模型里它只是一个小函数，但可以代表任何天然只属于某一侧分支的工作。

4. **父组件还是会跑。** 无论哪一列，`FriendList` 都是 37，因为在线人数这个 Hook 住在父组件里。编译器不会凭空发明一套订阅，让列表函数睡过去。如果这二十次跳动处于热路径，结构上的修法是把 Hook 搬进 `OnlineBadge`——有没有编译器，这都是好主意。

完整程序如下。在同一解释器中运行，会得到上面这份输出。

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple


@dataclass(frozen=True)
class Friend:
    id: int
    name: str


@dataclass
class State:
    friends: Tuple[Friend, ...]
    query: str
    selected_id: Optional[int]
    online_count: int
    theme_token: str


class Counters:
    def __init__(self) -> None:
        self.calls: Dict[str, int] = {}
        self.filter_runs = 0
        self.merge_theme_runs = 0

    def call(self, name: str) -> None:
        self.calls[name] = self.calls.get(name, 0) + 1

    def row(self) -> Dict[str, int]:
        out = dict(self.calls)
        out["filter"] = self.filter_runs
        out["merge_theme"] = self.merge_theme_runs
        return out


def filter_friends(friends: Tuple[Friend, ...], query: str, ctr: Counters) -> List[Friend]:
    ctr.filter_runs += 1
    q = query.lower()
    return [f for f in friends if q in f.name.lower()]


def merge_theme(token: str, ctr: Counters) -> str:
    ctr.merge_theme_runs += 1
    return f"theme:{token}"


class SlotCache:
    def __init__(self) -> None:
        self.slots: Dict[str, Tuple[Tuple[Any, ...], Any]] = {}

    def get(self, key: str, deps: Tuple[Any, ...], compute: Callable[[], Any]) -> Any:
        prev = self.slots.get(key)
        if prev is not None and prev[0] == deps:
            return prev[1]
        value = compute()
        self.slots[key] = (deps, value)
        return value


class Runtime:
    def __init__(self) -> None:
        self.caches: Dict[str, SlotCache] = {}

    def cache(self, identity: str) -> SlotCache:
        c = self.caches.get(identity)
        if c is None:
            c = SlotCache()
            self.caches[identity] = c
        return c


def shallow_equal(a: Dict[str, Any], b: Optional[Dict[str, Any]]) -> bool:
    if b is None or a.keys() != b.keys():
        return False
    return all(a[k] is b[k] or a[k] == b[k] for k in a)


class Strategy:
    name = ""

    def __init__(self) -> None:
        self.rt = Runtime()
        self.prev_props: Dict[str, Optional[Dict[str, Any]]] = {}
        self.mounted: set[str] = set()
        self._seen: set[str] = set()

    def begin(self) -> None:
        self._seen = set()

    def sweep(self) -> None:
        for identity in list(self.mounted):
            if identity not in self._seen:
                self.mounted.discard(identity)
                self.prev_props.pop(identity, None)
                self.rt.caches.pop(identity, None)
        self.mounted |= self._seen

    def maybe_run_memo(self, identity, props, body, enabled):
        self._seen.add(identity)
        if enabled and identity in self.mounted and shallow_equal(
            props, self.prev_props.get(identity)
        ):
            return
        self.prev_props[identity] = props
        body()


class Naive(Strategy):
    name = "naive"

    def render(self, state, ctr):
        friend_list(self, state, ctr, False, False, False, False, False)


class ManualBroken(Strategy):
    name = "manual_broken"

    def render(self, state, ctr):
        friend_list(self, state, ctr, True, False, False, False, False)


class ManualCorrect(Strategy):
    name = "manual_correct"

    def render(self, state, ctr):
        friend_list(self, state, ctr, True, True, True, False, True)


class Compiler(Strategy):
    name = "compiler"

    def render(self, state, ctr):
        friend_list(self, state, ctr, True, True, True, True, True)


def friend_list(strat, state, ctr, memo_cards, memo_chrome, memo_filter, memo_theme, stable_handler):
    strat.begin()
    ctr.call("FriendList")
    cache = strat.rt.cache("FriendList")

    if memo_filter:
        visible = cache.get(
            "filter",
            (state.friends, state.query),
            lambda: filter_friends(state.friends, state.query, ctr),
        )
    else:
        visible = filter_friends(state.friends, state.query, ctr)

    if stable_handler:
        def on_select(fid: int) -> None:
            return None
        on_select = cache.get("on_select", (), lambda: on_select)
    else:
        def on_select(fid: int) -> None:
            return None

    def online_badge() -> None:
        ctr.call("OnlineBadge")

    def message_button() -> None:
        ctr.call("MessageButton")

    def no_friends(theme: str) -> None:
        ctr.call("NoFriends")

    def friend_card(friend, selected, handler) -> None:
        ctr.call("FriendCard")

    if len(visible) == 0:
        if memo_theme:
            theme = cache.get(
                "theme_empty",
                (state.theme_token,),
                lambda: merge_theme(state.theme_token, ctr),
            )
        else:
            theme = merge_theme(state.theme_token, ctr)
        strat.maybe_run_memo("NoFriends", {"theme": theme}, lambda: no_friends(theme), memo_chrome)
        strat.maybe_run_memo("OnlineBadge", {"count": state.online_count}, online_badge, memo_chrome)
        strat.sweep()
        return

    if memo_theme:
        theme = cache.get(
            "theme_list",
            (state.theme_token,),
            lambda: merge_theme(state.theme_token, ctr),
        )
    else:
        theme = merge_theme(state.theme_token, ctr)
    _ = theme

    strat.maybe_run_memo("OnlineBadge", {"count": state.online_count}, online_badge, memo_chrome)
    strat.maybe_run_memo("MessageButton", {}, message_button, memo_chrome)

    for friend in visible:
        selected = friend.id == state.selected_id
        if stable_handler:
            handler = on_select
        else:
            def handler(fid: int = friend.id) -> None:
                return None
        strat.maybe_run_memo(
            f"FriendCard:{friend.id}",
            {"friend": friend, "selected": selected, "on_select": handler},
            lambda f=friend, s=selected, h=handler: friend_card(f, s, h),
            memo_cards,
        )
    strat.sweep()


NAMES = [
    "Ada", "Alan", "Alice", "Amir", "Ann", "Asha", "Bea", "Ben",
    "Cara", "Chen", "Cora", "Dan", "Deb", "Eve", "Eli", "Fay",
    "Gus", "Hana", "Ivy", "Jia", "Kai", "Lea", "Mo", "Nina",
    "Omar", "Pia", "Quin", "Raj", "Sam", "Tess", "Uma", "Val",
    "Wes", "Xan", "Yan", "Zoe",
]


def make_friends(n: int):
    return tuple(Friend(i, f"{NAMES[i % len(NAMES)]}{i // len(NAMES)}") for i in range(n))


def scenario(n: int = 200):
    friends = make_friends(n)
    state = State(friends, "", None, 47, "light")
    steps = []

    def push(label, **updates):
        nonlocal state
        d = dict(
            friends=state.friends, query=state.query, selected_id=state.selected_id,
            online_count=state.online_count, theme_token=state.theme_token,
        )
        d.update(updates)
        state = State(**d)
        steps.append((label, state))

    push("initial")
    for q in ["a", "al", "ali", "alic", "alice", "alice0", "alice0x", "no-such-name"]:
        push(f"query={q!r}", query=q)
    push("query-cleared", query="")
    for sid in [0, 1, 2, 3, 4]:
        push(f"select={sid}", selected_id=sid)
    for i in range(20):
        push(f"online-tick-{i + 1}", online_count=47 + i + 1)
    changed = list(state.friends)
    changed[0] = Friend(0, "Ada0*")
    push("rename-friend-0", friends=tuple(changed))
    push("theme-dark", theme_token="dark")
    return steps


def run(strat, steps):
    ctr = Counters()
    per = []
    prev = Counters().row()
    for label, state in steps:
        strat.render(state, ctr)
        now = ctr.row()
        per.append((label, {k: now.get(k, 0) - prev.get(k, 0) for k in now}))
        prev = now
    return ctr, per


def main():
    steps = scenario(200)
    keys = ["FriendList", "FriendCard", "OnlineBadge", "MessageButton", "NoFriends", "filter", "merge_theme"]
    print(f"Steps: {len(steps)}  Friends: 200")
    print()
    for cls in (Naive, ManualBroken, ManualCorrect, Compiler):
        ctr, _ = run(cls(), steps)
        print(f"== {cls.name} ==")
        print("  ".join(f"{k}={ctr.row().get(k, 0)}" for k in keys))
        print()

    bands = [
        ("initial", 0, 1),
        ("8 query keystrokes (last empty)", 1, 9),
        ("query cleared", 9, 10),
        ("5 selections", 10, 15),
        ("20 online-count ticks", 15, 35),
        ("rename friend 0", 35, 36),
        ("theme token change", 36, 37),
    ]
    print("== phase totals (FriendCard / filter / merge_theme / FriendList) ==")
    rows_by = {cls.name: run(cls(), steps)[1] for cls in (Naive, ManualBroken, ManualCorrect, Compiler)}
    for label, a, b in bands:
        cells = []
        for name in ("naive", "manual_broken", "manual_correct", "compiler"):
            acc = {"FriendCard": 0, "filter": 0, "merge_theme": 0, "FriendList": 0}
            for _, delta in rows_by[name][a:b]:
                for k in acc:
                    acc[k] += delta.get(k, 0)
            cells.append(f"{acc['FriendCard']}/{acc['filter']}/{acc['merge_theme']}/{acc['FriendList']}")
        print(f"{label:<34} {cells[0]:>16} {cells[1]:>16} {cells[2]:>16} {cells[3]:>16}")
    print()
    print("Cell format: FriendCard / filter / merge_theme / FriendList")


if __name__ == "__main__":
    main()
```

## 小结

- React 会重新渲染一个组件，并且默认渲染它的整棵子树。在这个模型里，记忆化讨论的是*引用*：一个新的闭包或一个新的数组，就足以让 `React.memo` 未命中，哪怕底层数据并没有变。
- 手工记忆化可以在组件树上追平编译器，但前提是每一个处理函数、每一份依赖数组、每一条 `memo` 边界都写对，而且那些工作都能放在任何早返回*之前*。`useMemo` 不能出现在分支之后；缓存槽位可以。
- React Compiler 1.0（2025 年 10 月 7 日）是一个构建期优化器：以 Babel 为前端的流水线，把 AST 降到基于 CFG 的 HIR，分析数据流与可变性，并按作用域发出缓存检查。它已经在 Meta 用于生产环境，并且在 Expo SDK 54 中默认打开。它不改变 Fiber，也不引入 signal。
- Rules of React 是分析所依赖的输入。会修改 props、或无法被证明安全的代码会被跳过；这些违反应当先出现在 `eslint-plugin-react-hooks` 里，而不是先出现在编译插件里。
- 用 `compilationMode: 'annotation'` 和 `"use memo"` 渐进接入，用 `"use no memo"` 退出，保留已有的记忆化；如果缓存分组的变化不容易被发现，就把编译器钉在一个确切版本上。
- 编译器不会阻止一个读到了变化 Hook 的父组件运行，不会在组件之间共享记忆化，也不会取代 Server Components 或 islands。把 Hook 搬走，给共享的辅助函数自己做缓存，并把编译器看成：让你本来就会做的那些客户端更新更便宜。

## 参考文献

- React，[React Compiler](https://react.dev/learn/react-compiler)
- React，[React Compiler: Introduction](https://react.dev/learn/react-compiler/introduction)
- React，[React Compiler: Installation](https://react.dev/learn/react-compiler/installation)
- React，[React Compiler: Incremental Adoption](https://react.dev/learn/react-compiler/incremental-adoption)
- React，[Directives](https://react.dev/reference/react-compiler/directives)（`"use memo"`、`"use no memo"`）
- React，[`compilationMode`](https://react.dev/reference/react-compiler/compilationMode)
- React，[Configuration](https://react.dev/reference/react-compiler/configuration) 与 [版本兼容（`target`）](https://react.dev/reference/react-compiler/target)
- React，[Rules of React](https://react.dev/reference/rules)
- Lauren Tan、Joe Savona、Mofei Zhang，[React Compiler v1.0](https://react.dev/blog/2025/10/07/react-compiler-1)（2025 年 10 月 7 日）
- [React Compiler Playground](https://playground.react.dev)
- [React Compiler Working Group](https://github.com/reactwg/react-compiler)，包括 Sanity Studio 与 Wakelet 的接入记录
- [eslint-plugin-react-hooks](https://www.npmjs.com/package/eslint-plugin-react-hooks)
- Expo，[React Compiler 指南](https://docs.expo.dev/guides/react-compiler/)（SDK 54 及之后）
- Next.js，[reactCompiler](https://nextjs.org/docs/app/api-reference/config/next-config-js/reactCompiler) 以及 [15.3.1](https://github.com/vercel/next.js/releases/tag/v15.3.1) 的 swc 集成
