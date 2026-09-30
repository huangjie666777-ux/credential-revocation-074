import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Credential,
  EventPolicy,
  ProofPayload,
  Roster,
} from "../shared/types.js";
import { fetchRoster, generateProof, redeem, revoke } from "./prover.js";

interface ServerPolicy {
  merkleRoot: string;
  treeDepth: number;
  rosterVersion: number;
  events: EventPolicy[];
}

type Stage = "idle" | "proving" | "verifying" | "done";

interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

export function App() {
  const [policy, setPolicy] = useState<ServerPolicy | null>(null);
  const [policyError, setPolicyError] = useState("");
  const [roster, setRoster] = useState<Roster | null>(null);
  const [rosterMessage, setRosterMessage] = useState("");
  const [credential, setCredential] = useState<Credential | null>(null);
  const [credentialLabel, setCredentialLabel] = useState("");
  const [eventId, setEventId] = useState(1001);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState("");
  const [payload, setPayload] = useState<ProofPayload | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [revokeInput, setRevokeInput] = useState("");
  const [revokeResult, setRevokeResult] = useState("");
  const proofGeneration = useRef(0);

  const refreshPolicy = useCallback(async () => {
    const response = await fetch("/api/policy", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setPolicy((await response.json()) as ServerPolicy);
  }, []);

  const refreshRoster = useCallback(async (silent = false) => {
    setRosterMessage(silent ? "" : "正在下载完整当前名单……");
    try {
      const next = await fetchRoster();
      setRoster(next);
      setRosterMessage(`已刷新：版本 ${next.version}，共 ${next.leaves.length} 个叶承诺`);
      await refreshPolicy();
    } catch (err) {
      setRosterMessage(`名单刷新失败：${(err as Error).message}`);
    }
  }, [refreshPolicy]);

  useEffect(() => {
    refreshPolicy()
      .then(() => refreshRoster(true))
      .catch((err: Error) => setPolicyError(`无法获取服务端政策：${err.message}`));
  }, [refreshPolicy, refreshRoster]);

  const selectedEvent = useMemo(
    () => policy?.events.find((event) => event.eventId === eventId) ?? null,
    [policy, eventId],
  );

  const invalidate = useCallback(() => {
    proofGeneration.current += 1;
    setPayload(null);
    setOutcome(null);
    setError("");
    setStage("idle");
  }, []);

  const onImport = useCallback(
    async (file: File) => {
      invalidate();
      try {
        const parsed = JSON.parse(await file.text()) as Credential;
        if (
          typeof parsed.secret !== "string" ||
          !Number.isInteger(parsed.score) ||
          !Number.isInteger(parsed.leafIndex)
        ) {
          throw new Error("凭证字段缺失或格式错误");
        }
        if (BigInt(parsed.secret) <= 0n) throw new Error("秘密必须为非零值");
        if (parsed.score < 0 || parsed.score > 100) throw new Error("成绩超出 0-100");
        setCredential(parsed);
        setCredentialLabel(file.name);
      } catch (err) {
        setCredential(null);
        setCredentialLabel("");
        setError(`凭证导入失败：${(err as Error).message}`);
      }
    },
    [invalidate],
  );

  const onGenerate = useCallback(async () => {
    if (!credential || !roster || !selectedEvent) return;
    invalidate();
    const generation = proofGeneration.current;
    setStage("proving");
    try {
      const next = await generateProof(
        credential,
        roster,
        selectedEvent.eventId,
        selectedEvent.threshold,
      );
      if (generation !== proofGeneration.current) return;
      setPayload(next);
      setStage("done");
    } catch (err) {
      if (generation !== proofGeneration.current) return;
      setError(`证明生成失败：${(err as Error).message}`);
      setStage("idle");
    }
  }, [credential, roster, selectedEvent, invalidate]);

  const onVerify = useCallback(async () => {
    if (!payload || !roster) return;
    const generation = proofGeneration.current;
    setStage("verifying");
    setError("");
    setOutcome(null);
    try {
      const result = await redeem(payload);
      if (generation !== proofGeneration.current) return;
      setOutcome(result);
    } catch (err) {
      if (generation !== proofGeneration.current) return;
      setError(`核验请求失败：${(err as Error).message}`);
    } finally {
      if (generation === proofGeneration.current) setStage("done");
    }
  }, [payload, roster]);

  const onRevoke = useCallback(async () => {
    if (!roster) return;
    setRevokeResult("");
    const indices = [...new Set(
      revokeInput
        .split(/[\s,，]+/)
        .filter(Boolean)
        .map((item) => Number(item)),
    )];
    if (indices.some((index) => !Number.isInteger(index) || index < 0 || index > 15)) {
      setRevokeResult("非法请求：请输入 0-15 的叶子索引，整批未提交。");
      return;
    }
    const result = await revoke(indices, roster.version);
    if (result.status === 200) {
      const next = result.body as unknown as Roster;
      if (!Array.isArray(next.leaves) || next.leaves.length !== roster.leaves.length) {
        throw new Error("服务端返回名单格式错误");
      }
      setRoster({ version: next.version, root: next.root, leaves: next.leaves });
      setRevokeResult(`撤销成功：${indices.join(", ")}；新版本 ${next.version}`);
      await refreshPolicy();
    } else {
      setRevokeResult(`撤销被整批拒绝（HTTP ${result.status}）：${String(result.body.reason)}`);
      await refreshRoster(true);
    }
  }, [refreshPolicy, refreshRoster, revokeInput, roster]);

  return (
    <main className="page">
      <header>
        <h1>零知识成绩凭证核验</h1>
        <p className="sub">
          浏览器内下载承诺名单、本地定位叶并重建路径；秘密、成绩、位置和路径不上传。
        </p>
      </header>

      {policyError && <section className="card error">{policyError}</section>}

      <section className="card">
        <h2>机构撤销台</h2>
        <p>当前名单版本：<strong>{roster?.version ?? "加载中"}</strong></p>
        <p className="mono small break">当前根：{roster?.root}</p>
        <input
          value={revokeInput}
          onChange={(event) => setRevokeInput(event.target.value)}
          placeholder="批量叶子索引，如：3 7 11，或 3,7,11"
        />
        <button type="button" disabled={!roster} onClick={() => void onRevoke()}>
          按预期版本 {roster?.version} 撤销
        </button>
        <button type="button" className="secondary" onClick={() => void refreshRoster()}>
          刷新名单
        </button>
        {revokeResult && <p className="warn">{revokeResult}</p>}
        <p className="note">
          撤销只把公开承诺叶置零并重算深度 4 根；版本冲突、重复、越界或空批次均整批拒绝。
        </p>
      </section>

      <section className="card">
        <h2>1. 当前公开配置与名单</h2>
        {policy ? (
          <>
            <p>名单版本：{policy.rosterVersion}</p>
            <p className="mono break">受信当前根：{policy.merkleRoot}</p>
            <ul>{policy.events.map((event) => (
              <li key={event.eventId}>活动 {event.eventId} — {event.name}</li>
            ))}</ul>
            <button type="button" className="secondary" onClick={() => void refreshRoster()}>
              下载/刷新完整 16 叶名单
            </button>
            <p className="note">{rosterMessage}</p>
          </>
        ) : <p>加载中……</p>}
      </section>

      <section className="card">
        <h2>2. 导入凭证（仅留在本机）</h2>
        <input type="file" accept="application/json,.json" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onImport(file);
        }} />
        {credential && <div className="info">
          <span>已导入：{credentialLabel}</span>
          <span>成绩（仅本机显示）：{credential.score}</span>
          <span>秘密：{credential.secret.slice(0, 10)}…（不会上传）</span>
        </div>}
      </section>

      <section className="card">
        <h2>3. 选择活动并本地重建见证</h2>
        <select value={eventId} onChange={(event) => {
          setEventId(Number(event.target.value));
          invalidate();
        }}>
          {policy?.events.map((event) => (
            <option key={event.eventId} value={event.eventId}>
              {event.eventId} — {event.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!credential || !roster || stage === "proving"}
          onClick={() => void onGenerate()}
        >
          {stage === "proving" ? "电路计算中……" : "用当前名单生成证明"}
        </button>
        {roster && <p className="note">证明绑定名单版本 {roster.version}；更新名单后需重新生成。</p>}
      </section>

      <section className="card">
        <h2>4. 提交服务端核验与核销</h2>
        <button type="button" disabled={!payload || stage === "verifying"} onClick={() => void onVerify()}>
          {stage === "verifying" ? "核验中……" : "提交证明（仅公开信号）"}
        </button>
        {payload && <div className="info mono small">
          <span className="break">nullifier: {payload.publicSignals[0]}</span>
          <span className="break">root: {payload.publicSignals[1]}</span>
          <span>threshold: {payload.publicSignals[2]}</span>
          <span>eventId: {payload.publicSignals[3]}</span>
        </div>}
        {outcome && <pre className={outcome.body.redeemed ? "result ok" : "result warn"}>
          {`HTTP ${outcome.status}\n${JSON.stringify(outcome.body, null, 2)}`}
        </pre>}
        {error && <p className="error-text">{error}</p>}
        <p className="note">
          更换凭证、活动或刷新名单会废弃旧证明；晚到的异步证明不能恢复它。
          过期根、已撤销凭证、历史核销均不能绕过。
        </p>
      </section>
    </main>
  );
}
