# 星桥 NEBULA

**DSH Desktop 多会话协作插件**：共享上下文、任务路由、群组权限、积分人格，以及一个独立的社交窗口。

- 仓库：<https://github.com/Chen-Au/dsh-session-bridge>
- 许可证：MIT
- 开发/测试：`node dsh-plugin/test/contract.mjs`

## 状态

- 当前版本：v2.7.0
- 主分支：`main`
- 维护方式：欢迎通过 Issues / Discussions 反馈；PR 需通过离线契约测试
- 文档：见 [README](./README.md)、[CONTRIBUTING](./CONTRIBUTING.md)、[SECURITY](./SECURITY.md)

## 数据边界

本插件只在本地 DSH 数据目录读写；仓库中不包含任何会话、群组、凭据或个人路径。

## Language policy

- Every user-facing push and every GitHub Release must include an **English** summary.
- GitHub Release bodies must start with the English section, followed by the Chinese section; see [.github/RELEASE_TEMPLATE.md](./.github/RELEASE_TEMPLATE.md).
- Keep [README.md](./README.md) and [README.en.md](./README.en.md) in sync when features, install steps, or privacy notes change.
- Commit messages may stay short, but PR descriptions and release notes must be bilingual.
