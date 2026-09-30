import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { poseidon } from "../shared/poseidon.js";
import type { Credential, EventPolicy, ProofPayload, Roster } from "../shared/types.js";
import { fetchRoster, generateProof, redeem, revokeRoster } from "./prover.js";

interface ServerPolicy {
  merkleRoot: string;
  rosterVersion: number;
  treeDepth: number;
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
  const [revokeIndices, setRevokeIndices] = useState("0");
  const [expectedVersion, setExpectedVersion] = useState("");
  const [revokeResult, setRevokeResult] = useState("");
  const [revokeError, setRevokeError] = useState("");
  const proofGeneration = useRef(0);

  const loadRoster = useCallback(async (showMessage = true) => {
    setRosterMessage("");
    try {
      const next = await fetchRoster();
      setRoster(next);
      setExpectedVersion(String(next.version));
      if (showMessage) setRosterMessage(`名单已刷新：版本 ${next.version}`);
    } catch (err) {
      setRosterMessage(`名单刷新失败：${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    fetch("/api/policy")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const nextPolicy = (await res.json()) as ServerPolicy;
        setPolicy(nextPolicy);
        return loadRoster(false);
      })
      .catch((err: Error) => setPolicyError(`无法获取服务端政策：${err.message}`));
  }, [loadRoster]);

  useEffect(() => {
    setPayload(null);
    setOutcome(null);
    setError("");
    setStage("idle");
    proofGeneration.current += 1;
  }, [credential, eventId, roster]);

  const selectedEvent = useMemo(
    () => policy?.events.find((event) => event.eventId === eventId) ?? null,
    [policy, eventId],
  );

  const [holderStatus, setHolderStatus] = useState<{
    leafIndex: number;
    revoked: boolean;
    rootMatched: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHolderStatus(null);
    if (!credential || !roster) return;
    void (async () => {
      try {
        const hash = await poseidon();
        const leaf = hash([BigInt(credential.secret), BigInt(credential.score)]);
        const leafIndex = roster.leaves.findIndex((candidate) => BigInt(candidate) === leaf);
        if (!cancelled) {
          setHolderStatus({
            leafIndex,
            revoked: leafIndex >= 0 && BigInt(roster.leaves[leafIndex]) === 0n,
            rootMatched: Boolean(policy && roster.root === policy.merkleRoot),
          });
        }
      } catch {
        if (!cancelled) setHolderStatus({ leafIndex: -1, revoked: false, rootMatched: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [credential, roster, policy]);

  const onImport = useCallback(
    async (file: File) => {
      setError("");
      try {
        const parsed = JSON.parse(await file.text()) as Credential;
        if (
          typeof parsed.secret !== "string" ||
          !Number.isInteger(parsed.score) ||
          !Number.isInteger(parsed.leafIndex) ||
          !Array.isArray(parsed.pathElements) ||
          !Array.isArray(parsed.pathIndices)
        ) {
          throw new Error("凭证字段缺失或格式错误");
        }
        if (!/^\d+$/.test(parsed.secret) || BigInt(parsed.secret) <= 0n) {
          throw new Error("秘密必须为非零十进制值");
        }
        if (parsed.score < 0 || parsed.score > 100) throw new Error("成绩超出 0-100");
        setCredential(parsed);
        setCredentialLabel(file.name);
      } catch (err) {
        setCredential(null);
        setCredentialLabel("");
        setError(`凭证导入失败：${(err as Error).message}`);
      }
    },
    [],
  );

  const onGenerate = useCallback(async () => {
    if (!credential || !roster || !selectedEvent || holderStatus?.revoked) return;
    const generation = ++proofGeneration.current;
    setPayload(null);
    setOutcome(null);
    setError("");
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
      setError(
        holderStatus?.revoked
          ? "该凭证已被撤销，禁止出证。"
          : `证明生成失败：${(err as Error).message}`,
      );
      setStage("idle");
    }
  }, [credential, roster, selectedEvent, holderStatus]);

  const onVerify = useCallback(async () => {
    if (!payload) return;
    const proofToSubmit = payload;
    setStage("verifying");
    setError("");
    setOutcome(null);
    try {
      const result = await redeem(proofToSubmit);
      if (proofToSubmit !== payload) return;
      setOutcome(result);
    } catch (err) {
      if (proofToSubmit !== payload) return;
      setError(`核验请求失败：${(err as Error).message}`);
    } finally {
      if (proofToSubmit === payload) setStage("done");
    }
  }, [payload]);

  const onRevoke = useCallback(async () => {
    setRevokeError("");
    setRevokeResult("");
    const version = Number(expectedVersion);
    const indices = revokeIndices
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(Number);
    const result = await revokeRoster(version, indices);
    if (result.status === 200) {
      const nextRoster = (result.body.roster as Roster) ?? null;
      if (nextRoster) setRoster(nextRoster);
      setRevokeResult(`撤销成功，新版本 ${nextRoster?.version ?? "?"}`);
    } else {
      setRevokeError(`撤销被整批拒绝：${String(result.body.reason ?? result.status)}`);
    }
    await loadRoster(false);
  }, [expectedVersion, revokeIndices, loadRoster]);

  const revoked = holderStatus?.revoked === true;

  return (
    <main className="page">
      <header>
        <h1>零知识成绩凭证核验</h1>
        <p className="sub">名单只含叶子承诺；秘密、成绩、叶子位置与重建路径均留在浏览器。</p>
      </header>

      {policyError && <section className="card error">{policyError}</section>}

      <section className="card">
        <h2>1. 当前名单与活动政策</h2>
        {policy && roster ? (
          <>
            <div className="info">
              <span>名单版本：{roster.version}</span>
              <span>已撤销索引：{roster.revokedIndices.join(", ") || "无"}</span>
              <span className="mono small break">当前根：{roster.root}</span>
            </div>
            <button type="button" onClick={() => void loadRoster()}>
              下载/刷新完整名单
            </button>
            <span className="note">{rosterMessage || "名单含 16 个公开叶子承诺，撤销叶保持原位置置零。"}</span>
            <ul>
              {policy.events.map((event) => (
                <li key={event.eventId}>
                  活动 {event.eventId} — {event.name}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>加载中……</p>
        )}
      </section>

      <section className="card">
        <h2>2. 机构撤销（整批原子提交）</h2>
        <label>
          预期版本
          <input
            value={expectedVersion}
            onChange={(event) => setExpectedVersion(event.target.value)}
          />
        </label>
        <label>
          叶子索引（逗号分隔）
          <input
            value={revokeIndices}
            onChange={(event) => setRevokeIndices(event.target.value)}
          />
        </label>
        <button type="button" onClick={() => void onRevoke()} disabled={!roster}>
          批量撤销
        </button>
        {revokeResult && <p className="ok">{revokeResult}</p>}
        {revokeError && <p className="error-text">{revokeError}</p>}
      </section>

      <section className="card">
        <h2>3. 导入凭证并本地定位</h2>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onImport(file);
          }}
        />
        {credential && holderStatus && (
          <div className="info">
            <span>已导入：{credentialLabel}</span>
            {holderStatus.leafIndex < 0 ? (
              <span className="error-text">当前名单没有该凭证承诺，请刷新或确认凭证。</span>
            ) : (
              <>
                <span>本地定位到叶子索引：{holderStatus.leafIndex}</span>
                <span className={revoked ? "error-text" : "ok"}>
                  {revoked ? "该资格已撤销，禁止出证。" : "该承诺在当前名单中有效。"}
                </span>
              </>
            )}
            <span>成绩仅本机显示：{credential.score}</span>
          </div>
        )}
      </section>

      <section className="card">
        <h2>4. 本地生成并提交证明</h2>
        <select
          value={eventId}
          onChange={(event) => setEventId(Number(event.target.value))}
        >
          {policy?.events.map((event) => (
            <option key={event.eventId} value={event.eventId}>
              {event.eventId} — {event.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!credential || !roster || stage === "proving" || revoked || holderStatus?.leafIndex === -1}
          onClick={() => void onGenerate()}
        >
          {stage === "proving" ? "电路计算中……" : "用当前名单本地生成证明"}
        </button>
        <button
          type="button"
          disabled={!payload || stage === "verifying"}
          onClick={() => void onVerify()}
        >
          {stage === "verifying" ? "核销中……" : "提交公开信号核销"}
        </button>
        {selectedEvent && credential && !revoked && (
          <p className={credential.score >= selectedEvent.threshold ? "ok" : "warn"}>
            成绩 {credential.score}
            {credential.score >= selectedEvent.threshold
              ? ` ≥ 门槛 ${selectedEvent.threshold}`
              : ` &lt; 门槛 ${selectedEvent.threshold}，电路会拒绝出证`}
          </p>
        )}
        {payload && (
          <div className="info mono small">
            <span className="break">nullifier: {payload.publicSignals[0]}</span>
            <span className="break">root: {payload.publicSignals[1]}</span>
            <span>threshold: {payload.publicSignals[2]}</span>
            <span>eventId: {payload.publicSignals[3]}</span>
          </div>
        )}
        {outcome && (
          <pre className={outcome.body.redeemed ? "result ok" : "result warn"}>
            {`HTTP ${outcome.status}\n${JSON.stringify(outcome.body, null, 2)}`}
          </pre>
        )}
        {error && <p className="error-text">{error}</p>}
        <p className="note">
          更换凭证、活动或刷新名单后旧证明立即废弃；晚到的异步证明不会恢复。核销只接受当前根，历史 nullifier 不随名单更新清空。
        </p>
      </section>
    </main>
  );
}
