# PageDiff `<br>` 形态矩阵与停机结论

> 日期：2026-07-29  
> 结论：**停止 diff 重建方案；不执行 3,000 条联网试点。**  
> 原因不是尚缺样本，而是 PageDiff HTML 对两侧源码不是单射：同一完整
> HTML 可以对应两个不同旧版（或新版），所以 `<br>` 归属无法从 HTML 推断。

## 1. 证据与口径

- 本地真实证据：
  `revision-diff-23676-1497968268`（多行 `ins`）、
  `revision-diff-27409-870095552`（多行/单行 `del`）、
  `revision-diff-23900-1525146346`（单行替换、空 `ins`、空行改写）。
- Wikidot 官方开源实现
  [`PageDiffModule.php`](https://github.com/gabrys/wikidot/blob/0d0e6e604a47a831ee86ae027272f0faa920ead1/php/modules/history/PageDiffModule.php#L70-L88)
  把两侧全文交给
  [`generateInlineStringDiff()`](https://github.com/gabrys/wikidot/blob/0d0e6e604a47a831ee86ae027272f0faa920ead1/php/utils/Wikidot_Util_Diff.php#L127-L232)；
  后者先做行级 diff、把相邻 delete/add 降成行内 change，最后用 `"\n"` 拼行。
  模板的
  [`semipre`](https://github.com/gabrys/wikidot/blob/0d0e6e604a47a831ee86ae027272f0faa920ead1/php/smarty_plugins/modifier.semipre.php#L26-L33)
  再调用 `nl2br()`。
- 开源快照较旧，不能单独代表现网；但三份现网 HTML 与其行级输出模型一致。
  尤其 `1525146282 -> 1525146346` 的直接全文是“空行改为 `[[=]]`”，现网却只输出
  `<ins>[[=]]</ins><br />`，没有保留空侧标记。这正是不可逆信息损失。
- 下表把 `<br />` 及其后由 `nl2br()` 保留的 LF 合称 `B`。现有 PageSource
  解析会把它们还原成两个 LF，但这不影响归属反例：争议的是整个 `B` 属哪一侧。

## 2. 最小不可注入反例

两条合法历史产生同形 HTML `before B <ins>x</ins> B after`：

| 历史 | 旧侧 | 新侧 | 第二个 `B` |
|---|---|---|---|
| A：新增整行 | `before B after` | `before B x B after` | 仅新侧 |
| B：空行改写 | `before B B after` | `before B x B after` | 两侧共有 |

HTML 中没有行级 op、空侧占位或归属属性，故任何解析器都只能在 A/B 中猜一个。
当前 `inline-v3` 猜 B（单行非空块后的外置 `B` 归 common），所以必然无法重建 A。
将 `ins`/新旧侧互换即得到同形 `del` 反例：删除整行与“改成空行”无法区分。
离线测试“停机反例”固定了这两个碰撞，并明确断言当前解析结果只能匹配候选之一。

## 3. 形态矩阵

“归属”列是从 HTML **能证明**的结论；`?` 表示同形输入存在多种合法归属。
“当前处理”描述 `inline-v3`，不是把它认可为上游规则。

| ID | 块行数 | 位置/相邻关系 | `B` 位置 | 可证明归属 | `inline-v3` 当前处理 | 离线证据 |
|---|---|---|---|---|---|---|
| M00 | 0（空 diff） | 无 inline 容器 | 无 | 无源码可还原 | 两侧 `null`、空 patch | 既有测试 |
| M01 | 0（纯文本） | diff 开头/中间/结尾 | 块外 | common | common | 既有测试 |
| M02 | 单行 | 行中，块前后均有纯文本 | 后续块外 | common | 遇非空纯文本后清状态，common | 既有实体测试 |
| M03 | 单行 | 行首，块后夹纯文本 | 行尾 | common | common | 由 M02 对称 |
| M04 | 单行 | 行尾，块前夹纯文本 | 块后 | common | common | 既有实体测试 |
| M05 | 单行 | `<del>x</del><ins>y</ins>` | 块后 | common | 两类同时出现，common | 真实 23900 |
| M06 | 单行 | `<ins>x</ins><del>y</del>` | 块后 | common | 两类同时出现，common | 仅结构对称 |
| M07 | 单行 | 整行，仅 `ins` | 块后 | **? changed/common** | **猜 common** | **碰撞 C1** |
| M08 | 单行 | 整行，仅 `del` | 块后 | **? changed/common** | **猜 common** | **碰撞 C2** |
| M09 | 0（空块） | 整行 `<ins></ins>` | 块后 | insert（现网个例） | insert | 真实 23900 |
| M10 | 0（空块） | 整行 `<del></del>` | 块后 | delete（生成器对称） | delete | 无现网实例 |
| M11 | 多行 | 整行 `ins`，块内有 B | 块内 | insert | insert | 真实 23676 |
| M12 | 多行 | 整行 `ins` | 闭标签后 | insert（现网个例） | insert | 真实 23676 |
| M13 | 多行 | 整行 `del`，块内有 B | 块内 | delete | delete | 真实 27409 |
| M14 | 多行 | 整行 `del` | 闭标签后 | delete（现网个例） | delete | 真实 27409 |
| M15 | 多行 | 跨行 del 紧跟 ins | 各块内 | 各自侧 | 各自侧 | 生成器结构 |
| M16 | 任意 | 连续多个同类块 | 最后一块后 | **继承 M07–M14** | 合并同类状态后猜 | 生成器通常合块 |
| M17 | 任意 | 块之间夹纯文本 | 纯文本后 | common | 清状态后 common | 解析器状态测试缺口 |
| M18 | 任意 | del 紧跟 ins / ins 紧跟 del | 两块之间 | **取决于前块；可继承 ?** | 当场按前块猜并清状态 | 测试缺口 |
| M19 | 任意 | diff 开头 | 块外前 | common 或不存在 | common；最终 `trim()` | 测试缺口 |
| M20 | 任意 | diff 结尾 | 块外后 | **可继承 ?** | 按块形状猜；最终 `trim()` | 测试缺口 |
| M21 | 多行 | 整页重写，全 del + 全 ins | 块内/块后 | 内部各自；尾部视配对 | 两类并存时尾部 common | 测试缺口 |
| M22 | 0/多行 | 空页→全文 / 全文→空页 | diff 两端 | **可继承 M07/M08 的 ?** | 按空/单/多行猜 | 测试缺口 |

矩阵已经覆盖要求的空/单/多行、行首/行中/行尾/整行/跨行、两种相邻顺序、
连续同类、纯文本间隔、块内/块外前后/块间 `B`、diff 首尾、空 diff 与整页重写。
但 M07/M08 是不可消除的同形碰撞；M16/M18/M20/M22 又会继承它们。

## 4. 门禁结论

1. 形态空间可按 token 状态压缩成有限矩阵，但“HTML → 两侧源码”不是函数；
   增加更多矩阵格、测试或联网样本都不能补回被 renderer 丢掉的行级 op。
2. 因矩阵存在不可判定格，不满足“每格有测试且通过”，故禁止 3,000 条最终试点，
   也不应为 `inline-v3` 写 `passed=true` 门禁。
3. 继续方向只能二选一：历史版本存 PageSource 全文；或 PageDiff 只作展示/审计，
   不承担重建。选择与迁移不在本次“改变验证方法”的授权范围内。
