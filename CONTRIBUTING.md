# 参与贡献

## 环境要求

- Node.js ≥ 20、pnpm 9
- 首次:`pnpm install && pnpm -r build`

## 开发流程

```bash
pnpm -r typecheck   # 类型检查
pnpm -r test        # 全量测试(vitest,全本地、无外部依赖)
pnpm -r run build   # 依赖链 core → runtime/protocol → 其余包 → gateway
```

## 约定

1. **凭证红线**:任何密钥/令牌不得入库(`pnpm gate:creds` 会扫描;`.env`、`.genie/secrets.json` 已 gitignore)。
2. **测试先行**:行为改动必须带测试;测试全本地,外部 LLM 用 `packages/test-support` 的 mock 服务模拟。
3. **提交信息**:英文或中文均可,首行 <=72 字符,建议格式 `type(scope): summary`(如 `feat(panel): 画布模式切换入口`)。
4. **架构纪律**:agent 改代码前先走 code-sense 影响面;P0 证据不齐不算完成——README「主线」一节是判断改动是否偏航的基准。

## 提交前自检

- `git diff --staged` 里没有密钥、令牌、本机绝对路径;
- 新增依赖有明确理由(本仓刻意保持小依赖面);
- 面板/资产改动在浏览器与桌面两种形态下都过一遍。

## Issue / PR

- Bug 报告请附:平台(Windows/macOS/Linux)、Node 版本、最小复现步骤、journal 片段(注意脱敏);
- PR 请关联 issue,并确认 CI 全绿。
