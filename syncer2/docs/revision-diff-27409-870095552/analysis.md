# revision 870095552 失败归因

目标相邻版本为 `page_id=27409`、Wikidot page `822940057`、
`870091898 -> 870095552`。取证脚本是
`experiments/revision-diff-forensics.ts`；本目录保留了 PageDiff 原始 HTML、
两次 PageSource 原始 HTML、两侧解析后全文、旧/新解析器产物与 SHA-256。

## 字节级结论

- `diff.raw.html`：96,266 B，SHA-256
  `33d55ca12912be33f5b233d9bd40dd696424c742e66963980fa5b6f9bff9a196`。
- 旧侧全文：91,305 B，SHA-256
  `b73cedac27732b47af7214ab8b8aebf147c6bcd834f7b93f994b626c9bc97c82`。
- 新侧全文：91,221 B，SHA-256
  `c1c572643e150477019843a93c8b9355f33bbef421c6730843cede7b2fc5a690`。
- `inline-v2` 的旧侧逐字节相等；新侧首差异在 UTF-8 byte 4,322，且从
  byte 4,324 后到 EOF 的 86,897 B 全部相等。唯一差异是新侧少了两个 `0a`
  (`"\n\n"`)；不是正文内容、实体或超长行损坏。

原始结构只有两个独立的整行删除块，没有 `<ins>`：

```html
<del>[[module CSS]]<br />
@import url(/component:broken-masquerade-theme/code/1);</del><br />
<del>[[/module]]</del><br />
[[collapsible ...]]
```

Wikidot 对闭标签外 `<br />` 的归属取决于 change 块形状，而不是只取决于
`<del>`/`<ins>`：块内已经含 `<br />` 的多行 change，其外置换行只属于变化侧；
单行非空 change 的外置换行属于两侧；空 change 表示新增/删除空行，仍只属于变化侧。
本例第一个 `<del>` 是多行块，第二个是单行块；`inline-v2` 把两者都按多行块处理，
因此第二块后从新侧多删了两个 `0a`。`inline-v3` 记录“块内 br / 非空”状态后，
两侧均与 PageSource 全文逐字节一致，同时 `1497968268` 的多行 `<ins>` 仍通过。

## 截断检查

这条不是 Wikidot 大 diff 静默截断：

- 96,266 B 的 diff HTML 有完整的两个 `</del>`、799 个 `<br>` 和两层闭合
  `</div>`，并包含页面末尾导航与分隔线。
- diff 还原的旧侧从头到尾完全相等；`inline-v2` 新侧除局部两个换行外，
  后续 86,897 B 直至 EOF 完全相等。
- `inline-v3` 从同一份原始 HTML 还原的两侧 SHA-256 均与两次独立 PageSource
  请求一致。

所以至少在本次 96 KB diff / 91 KB 两侧全文范围内不存在长度上限或静默截断，
失败属于行级 `<del>` 边界解析 bug，不支持改成“大页直接存全文”的设计结论。
第三轮抽样已配置为实际 `>50,000 B` 的修订至少 200/1,000，并继续用独立
PageSource 全文逐字节验证更大的响应；任何一条不一致，门禁都会立即
记 `passed=false` 并停止长跑。

## 第三轮停止记录

`inline-v3` 首次联网试点按门禁在 4/1,000 exact 后停止并写入
`meta.revision_source_pilot(passed=false)`；失败点是
`page=23900, 1525146282 -> 1525146346`。它包含单行非空 `<ins>`、同一行
`<del>/<ins>` 替换和空 `<ins></ins>` 三种相邻形态，暴露出第一版 v3 只区分
`del/ins`、没有区分多行/单行/空行。该样本的 81,497 B 原始 diff 与两侧全文已
保存到 `../revision-diff-23900-1525146346/`；补齐形状状态机后，三个真实回归
`1497968268 / 870095552 / 1525146346` 均已离线逐字节通过。依照“一条不一致即停”
的验收要求，本轮没有再次联网试点，也没有开启长跑。
