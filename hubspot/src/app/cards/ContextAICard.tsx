import React, { useEffect, useState } from "react";
import { Button, Divider, Flex, Heading, Link, Text, hubspot } from "@hubspot/ui-extensions";

type ActionType = "call" | "email" | "sequence" | "manual_enrichment" | "nurture" | "disqualify";
type CardData = {
  evaluatedAt: string;
  score: number | null;
  band: string;
  confidence: string;
  drivers: Array<{ text: string; sources: Array<{ name: string; url: string | null }> }>;
  hook: string;
  dataQuality: {
    missing: string[];
    stale: string[];
    conflicts: string[];
    manualReview: string[];
    failedSources: Array<{ source: string; status: string }>;
  };
  writeback: { status: string; reason: string };
  scoreVersion: string;
};
type CardContext = { variables?: Record<string, unknown>; crm: { objectId: number; objectTypeId: string } };

hubspot.extend<"crm.record.sidebar">(({ context, actions }) => <ContextAICard context={context} notify={actions.addAlert} />);

const labels: Record<ActionType, string> = {
  call: "Call", email: "Email", sequence: "Sequence", manual_enrichment: "Enrich manually", nurture: "Nurture", disqualify: "Disqualify",
};
const list = (items: string[]) => items.length ? items.join(", ") : "None";

function ContextAICard({ context, notify }: Readonly<{ context: CardContext; notify: (input: { type: "success" | "danger"; message: string }) => void }>) {
  const [data, setData] = useState<CardData | null>(null);
  const [error, setError] = useState("");
  const [actionType, setActionType] = useState<ActionType>();
  const [saving, setSaving] = useState(false);
  const apiUrl = context.variables?.CONTEXTAI_API_URL;
  const endpoint = `${String(apiUrl ?? "").replace(/\/$/, "")}/hubspot/crm-card`;
  const record = { objectId: String(context.crm.objectId), objectTypeId: context.crm.objectTypeId };

  const request = async (body: Record<string, unknown>) => {
    const response = await hubspot.fetch(endpoint, { method: "POST", body, timeout: 10_000 });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "ContextAI is unavailable");
    return result;
  };

  useEffect(() => {
    if (!apiUrl) return setError("CONTEXTAI_API_URL is not configured for this HubSpot project profile");
    request({ operation: "view", ...record }).then(setData).catch((cause) => setError(cause instanceof Error ? cause.message : "ContextAI is unavailable"));
  }, [apiUrl, record.objectId, record.objectTypeId]);

  const disposition = async (value: "accepted" | "ignored" | "overridden") => {
    setSaving(true);
    try {
      await request({ operation: "outcome", ...record, disposition: value, ...(actionType ? { actionType } : {}) });
      notify({ type: "success", message: "Recommendation response recorded. No CRM action was executed." });
    } catch (cause) {
      notify({ type: "danger", message: cause instanceof Error ? cause.message : "Could not record response" });
    } finally {
      setSaving(false);
    }
  };

  if (error) return <Flex direction="column" gap="small"><Heading>ContextAI unavailable</Heading><Text>{error}</Text><Text>Use HubSpot normally; ContextAI never blocks record work.</Text></Flex>;
  if (!data) return <Text>Loading latest ContextAI evaluation…</Text>;
  const review = data.band === "Needs Manual Review" || data.dataQuality.manualReview.length > 0;

  return <Flex direction="column" gap="medium">
    <Flex direction="column" gap="extra-small">
      <Heading>{data.score ?? "—"} · {data.band}</Heading>
      <Text>{data.confidence} confidence · evaluated {new Date(data.evaluatedAt).toLocaleString()}</Text>
      <Text>Score version {data.scoreVersion}</Text>
    </Flex>
    {review && <Text>Manual review required. The available context remains visible below.</Text>}
    <Divider />
    <Heading>Why now</Heading>
    {data.drivers.length ? data.drivers.map((driver, index) => <Flex key={`${driver.text}-${index}`} direction="column" gap="extra-small">
      <Text>{driver.text}</Text>
      <Text>{driver.sources.map((source, sourceIndex) => <React.Fragment key={`${source.name}-${sourceIndex}`}>
        {sourceIndex > 0 ? ", " : "Source: "}{source.url ? <Link href={source.url}>{source.name}</Link> : source.name}
      </React.Fragment>)}</Text>
    </Flex>) : <Text>No approved score drivers are available.</Text>}
    <Heading>Grounded hook</Heading>
    <Text>{data.hook}</Text>
    <Divider />
    <Heading>Data quality</Heading>
    <Text>Missing: {list(data.dataQuality.missing)}</Text>
    <Text>Stale: {list(data.dataQuality.stale)}</Text>
    <Text>Conflicts: {list(data.dataQuality.conflicts)}</Text>
    <Text>Failed sources: {list(data.dataQuality.failedSources.map(({ source, status }) => `${source} (${status})`))}</Text>
    <Heading>Writeback</Heading>
    <Text>{data.writeback.status}: {data.writeback.reason}</Text>
    <Divider />
    <Heading>Observed rep action</Heading>
    <Text>Select what you did or plan to do. ContextAI records the selection; it does not execute it.</Text>
    <Flex direction="column" gap="extra-small">
      {(Object.keys(labels) as ActionType[]).map((value) => <Button key={value} variant={actionType === value ? "primary" : "secondary"} onClick={() => setActionType(value)}>{labels[value]}</Button>)}
    </Flex>
    <Heading>Recommendation</Heading>
    <Flex direction="column" gap="extra-small">
      <Button disabled={saving || review} onClick={() => disposition("accepted")}>Accept</Button>
      <Button disabled={saving} onClick={() => disposition("overridden")}>Override</Button>
      <Button disabled={saving} onClick={() => disposition("ignored")}>Ignore</Button>
    </Flex>
  </Flex>;
}
