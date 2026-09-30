# 零知识成绩凭证核验（ZK Qualification）

学员向培训机构证明“成绩达到某活动门槛且属于受信学员集合”，但不透露具体成绩、身份或秘密。证明在浏览器内以 Groth16 生成，服务端只持有受信 Merkle 根和活动政策。

## 架构与隐私边界

- 发证方离线生成 16 份演示凭证和公开名单：凭证含非零 `secret`、整数成绩 `score`（0–100）；`credentials/roster.json` 与服务端 `data/roster.json` 仅含版本、16 个叶承诺和当前根，叶子为 `Poseidon(secret, score)`。
- 服务端配置只有公开名单、树深度与两个活动门槛（`data/policy.json` 不存秘密或成绩）。机构撤销时按叶子索引把对应承诺置为 `0`，位置不变、深度 4 根重算、版本原子递增。
- 浏览器导入凭证后下载完整当前名单，在本机用 `secret + score` 计算承诺并定位叶索引，再重建 Merkle 路径。上传内容只有证明与 4 个公开信号：`root, threshold, eventId, nullifier`，其中 `nullifier = Poseidon(secret, eventId)`。本人位置、`secret`、成绩、路径不发送给服务端。
- 已撤销者的承诺在名单中找不到，浏览器明确提示“已撤销或不在当前名单中”并禁止出证；未撤销者不需要重新领证，刷新名单即可生成新根下的真实证明。
- 电路（`circuits/qualification.circom`）强制约束：成绩/门槛为 0–100 的非负整数（含 7 位二进制约束，拒绝字段负数包装值）、路径位为二进制、Merkle 成员关系成立、`score >= threshold`、secret 非零，且 nullifier 绑定 secret 与活动。前端判断无法替代或绕过约束。
- 服务端按当前名单与受信政策复核：公开信号中的根必须等于提交瞬间的当前根，门槛必须等于该活动配置门槛，eventId 必须匹配；撤销与核销由同一串行队列定序，验证开始后名单改变则最终核销拒绝过期根。
- 核销以 `(eventId, nullifier)` 为原子唯一键：同活动并发重复提交仅一次成功；证明失败不写入、不消耗资格；记录持久化到 `data/redemptions.json`，重启保留；不同活动相互独立。
- nullifier 在比较和持久化前规范化为无前导零十进制字符串，避免 `000...` 与规范值被当作两次核销；名单更新不会清空或绕过历史核销。

## 两个演示活动

| 活动 | eventId | 门槛 |
| --- | --- | --- |
| 精英训练营 | 1001 | 60 |
| 大师班 | 1002 | 85 |

演示成绩（共 16 人，见 `credentials/manifest.json`）包含：
- 达标：`credential-00.json`（95，两个活动均达标）、`credential-02.json`（85，恰好达到大师班门槛）、`credential-05.json`（60，恰好达到 60 门槛）。
- 不达标：`credential-06.json`（58，60 门槛即不达标）、`credential-15.json`（30，均不达标）。

不达标凭证在浏览器点击生成证明时会被电路直接拒绝（约束不满足，无法 witness 计算），没有任何前端绕过方式。

## 使用步骤

前置：Node.js 22、已安装依赖（`node_modules/` 已就绪）。

```bash
# 1. 编译电路并完成 Groth16 演示设置（产物写入 zk/ 与 public/zk/）
npm run zk:build

# 2. 生成 16 份凭证（credentials/）与服务端受信政策（data/policy.json）
npm run credentials:generate

# 3. 自测（电路约束、核销原子性、服务端政策）
npm test

# 4. 构建前端
npm run build

# 5. 启动服务端（127.0.0.1:3001）
npm run dev:server

# 6. 另开终端启动前端（Vite，端口 5200，代理 /api 到 3001）
npm run dev
```

打开 Vite 输出的地址：
- 机构撤销台输入一个或多个叶子索引（如 `1 3`），页面会携带当前显示的 `expectedVersion`；版本冲突、重复撤销、越界或空请求会整批拒绝。
- 持证人导入 `credentials/credential-00.json`，点击“下载/刷新完整 16 叶名单”，选择活动后本地重建路径并生成证明，再提交核验。
- 撤销后，旧证明立即因旧根失效；未撤销凭证刷新名单后可继续证明，已撤销凭证会被明确禁止出证。
- 更换凭证、活动或更新名单后旧证明立即废弃；异步证明晚到时不会恢复旧证明。

## curl 演示真实证明

```bash
# 查看初始公开名单（版本 0，16 个叶承诺；只含公开承诺，不含 secret/成绩）
curl -s http://127.0.0.1:3001/api/roster | jq '.version, .root, (.leaves|length)'

# 达标证明（credential 0, 成绩 95, 活动 1001 门槛 60）
npx tsx scripts/demoProof.ts 0 1001 /tmp/proof-ok.json
curl -s -X POST http://127.0.0.1:3001/api/redeem \
  -H 'Content-Type: application/json' --data @/tmp/proof-ok.json | jq
# 再次提交同一证明 -> 409 already redeemed
curl -s -X POST http://127.0.0.1:3001/api/redeem \
  -H 'Content-Type: application/json' --data @/tmp/proof-ok.json | jq

# 同一凭证参加另一活动（nullifier 不同，独立核销）
npx tsx scripts/demoProof.ts 0 1002 /tmp/proof-b.json
curl -s -X POST http://127.0.0.1:3001/api/redeem \
  -H 'Content-Type: application/json' --data @/tmp/proof-b.json | jq

# 撤销 credential 1（成绩 88，活动 1002 原本达标）。expectedVersion 必须为当前版本。
curl -s http://127.0.0.1:3001/api/roster | jq '{expectedVersion: .version, indices: [1]}' > /tmp/revoke.json
curl -s -X POST http://127.0.0.1:3001/api/revoke \
  -H 'Content-Type: application/json' --data @/tmp/revoke.json | jq

# 撤销后重新生成：credential 1 会在本地发现承诺已不在名单中，禁止出证。
npx tsx scripts/demoProof.ts 1 1002 /tmp/revoked-proof.json

# 未撤销的 credential 0 刷新当前名单后仍可证明；旧的 /tmp/proof-b.json 根已过期，提交得到 merkle root mismatch。
curl -s -X POST http://127.0.0.1:3001/api/redeem \
  -H 'Content-Type: application/json' --data @/tmp/proof-b.json | jq
```

不达标凭证（如索引 6，成绩 58）无法生成证明，`demoProof.ts` 在 witness 阶段即报错。

## 可信设置说明

`parameters/demo-pot12-final.ptau` 是本机单人生成的 BN128 Powers-of-Tau（power 12，支持 ≤4096 约束）通用参数；电路专用 phase-2 密钥由 `npm run zk:build` 在本地做单一方贡献（`zk/qualification_final.zkey`）。该仪式为**合成本地演示**，任何人持有该熵都可伪造证明，**不得用于生产**；生产环境需多方可信仪式（如 Hermes/通用 ceremony 的 phase-2 贡献）并保护毒废料。

## 目录

- `circuits/qualification.circom` — 成绩门槛 + Merkle 成员 + nullifier 电路
- `scripts/buildZk.ts` — 编译、Groth16 setup、导出验证密钥、发布浏览器产物
- `scripts/generateCredentials.ts` — 16 份凭证 + 受信政策
- `scripts/generateCredentials.ts` — 16 份凭证 + 公开名单 + 活动政策
- `scripts/demoProof.ts` — 命令行生成真实证明
- `server/` — Express 当前名单、原子撤销、核验与持久化核销
- `src/` — React 撤销台、名单刷新与浏览器内见证重建/证明生成
- `test/` — Vitest 电路/核销/服务端测试
