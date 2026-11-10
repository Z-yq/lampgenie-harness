# E2E 晋升事务与覆盖率审计(`scripts/e2e-promote.mjs`)

把「人工审核通过」的 E2E 用例从 pending 提升为正式 spec,并同步 fixture 与覆盖矩阵;整个过程是
**文件系统事务**:校验 → 备份 → 写盘 → 重读审计 → 失败整体回滚。矩阵里的 `count` 不再手写漂移,
一律与真实 spec 里的 `it(`/`test(` 调用数对账。

## 用法

```bash
# dry-run(默认):只校验并打印将执行的动作,绝不写盘
node scripts/e2e-promote.mjs --plan plan.json

# 真正晋升:必须同时给 --reviewed(人工审核确认)
node scripts/e2e-promote.mjs --plan plan.json --apply --reviewed

# 覆盖已存在的目标文件 / 指定晋升根
node scripts/e2e-promote.mjs --plan plan.json --apply --reviewed --force --root .
```

| 参数 | 说明 |
| --- | --- |
| `--plan <file>` | 晋升计划 JSON(必填) |
| `--apply` | 真正写盘;缺省为 dry-run |
| `--reviewed` | 人工审核确认;`--apply` 时必须(否则非零退出) |
| `--force` | 允许覆盖已存在的目标文件 |
| `--root <dir>` | 计划内相对路径的基准目录,缺省 cwd |

退出码:`0` 成功 / `1` 校验或审计失败(已回滚)/ `2` 用法错误(缺 `--plan`、计划读不到、`--apply` 缺 `--reviewed`)。

## 计划格式

```json
{
  "cases": [
    {
      "id": "case-a",
      "from": "test/ui/pending/a.spec.cjs",
      "to": "test/ui/a.spec.cjs",
      "fixtures": [{ "from": "test/ui/pending/fixtures/a.html", "to": "test/ui/fixtures/a.html" }],
      "matrix": {
        "path": "docs/e2e-matrix.json",
        "row": { "id": "case-a", "status": "covered", "spec": "test/ui/a.spec.cjs", "count": 3 }
      },
      "reviewed": true
    }
  ]
}
```

矩阵文件结构为 `{ "cases": [ ... ] }`(JSON.stringify 2 空格 + 换行);按 `row.id` upsert,其它行原样保留。

## 校验(dry-run 也跑)

- `from` 存在且是文件;`to` 已存在时必须有 `--force`;
- spec 文本含 `.skip(` / `.only(` / `skip:` / `only:` → 拒绝(半转正),注释行不计;
- 每个 fixture 的 `from` 存在,`to` 冲突同样看 `--force`;
- `matrix.path` 存在且可 `JSON.parse`(仅 `--apply` 允许新建);`row.id` 计划内唯一;`row.status` 只允许 `covered`;
- `row.count` 必须等于晋升内容的 `it(`/`test(` 数,不一致直接给 `expected/got`;
- `--apply` 时每个 `case.reviewed` 必须为 `true`,且 CLI 带 `--reviewed`。

## 事务与回滚

`applyPlan` 先把所有将被写到的文件(目标 spec、fixture、matrix)读进内存备份,再逐项 `copyFile`
与 matrix upsert;随后 `auditPlan` **重新从磁盘读**目标文件与 matrix:

- 目标 spec / fixture 必须存在;spec 无 skip/only;
- matrix 里能找到 `row.id`,其 `spec` 指向真实文件、`count` 与真实 `it(`/`test(` 数一致、`status=covered`。

任一步失败(包括 matrix 不可写、是目录、坏 JSON) → 恢复所有备份、删除本次新建文件、matrix 回写原文,
返回 `{ ok:false, errors, rolledBack:true }`,CLI 非零退出。成功返回 `{ ok:true, applied, matrixPath }`。

## 测试

```bash
node --check scripts/e2e-promote.mjs
cd apps/gateway && npx vitest run test/e2e-promote.test.ts
```
