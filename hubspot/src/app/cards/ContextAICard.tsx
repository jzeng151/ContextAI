import { useEffect, useRef, useState } from "react";
import {
  Alert,
  DescriptionList,
  DescriptionListItem,
  Divider,
  Flex,
  Heading,
  Link,
  LoadingButton,
  LoadingSpinner,
  StatusTag,
  Text,
  ToggleGroup,
  hubspot,
} from "@hubspot/ui-extensions";

type ActionType = "call" | "email" | "sequence" | "manual_enrichment" | "nurture" | "disqualify";
type Disposition = "accepted" | "ignored" | "overridden";
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
const actionOptions = (Object.keys(labels) as ActionType[]).map((value) => ({ value, label: labels[value] }));
const list = (items: string[]) => items.length ? items.join(", ") : "None";

function ContextAICard({ context, notify }: Readonly<{ context: CardContext; notify: (input: { type: "success" | "danger"; message: string }) => void }>) {
  const [data, setData] = useState<CardData | null>(null);
  const [error, setError] = useState("");
  const [actionType, setActionType] = useState<ActionType>();
  const [saving, setSaving] = useState<Disposition | null>(null);
  const apiUrl = context.variables?.CONTEXTAI_API_URL;
  const endpoint = `${String(apiUrl ?? "").replace(/\/$/, "")}/hubspot/crm-card`;
  const record = { objectId: String(context.crm.objectId), objectTypeId: context.crm.objectTypeId };
  const recordKey = `${record.objectTypeId}:${record.objectId}`;
  const recordGeneration = useRef({ key: recordKey, value: 0 });
  if (recordGeneration.current.key !== recordKey) {
    recordGeneration.current = { key: recordKey, value: recordGeneration.current.value + 1 };
  }

  const request = async (body: Record<string, unknown>) => {
    const response = await hubspot.fetch(endpoint, { method: "POST", body, timeout: 10_000 });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "ContextAI is unavailable");
    return result;
  };

  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    setActionType(undefined);
    setSaving(null);
    if (!apiUrl) {
      setError("CONTEXTAI_API_URL is not configured for this HubSpot project profile");
      return () => { active = false; };
    }
    request({ operation: "view", ...record })
      .then((result) => { if (active) setData(result); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "ContextAI is unavailable"); });
    return () => { active = false; };
  }, [apiUrl, record.objectId, record.objectTypeId]);

  const disposition = async (value: Disposition) => {
    const generation = recordGeneration.current.value;
    setSaving(value);
    try {
      await request({ operation: "outcome", ...record, disposition: value, ...(actionType ? { actionType } : {}) });
      if (recordGeneration.current.value === generation) notify({ type: "success", message: "Recommendation response recorded. No CRM action was executed." });
    } catch (cause) {
      if (recordGeneration.current.value === generation) notify({ type: "danger", message: cause instanceof Error ? cause.message : "Could not record response" });
    } finally {
      if (recordGeneration.current.value === generation) setSaving(null);
    }
  };

  if (error) return <Alert title="ContextAI unavailable" variant="danger"><Flex direction="column" gap="extra-small"><Text>{error}</Text><Text>Use HubSpot normally; ContextAI never blocks record work.</Text></Flex></Alert>;
  if (!data) return <LoadingSpinner label="Loading latest ContextAI evaluation" showLabel layout="centered" />;
  const review = data.band === "Needs Manual Review" || data.dataQuality.manualReview.length > 0;

  return <Flex direction="column" gap="medium">
    <Flex direction="column" gap="extra-small">
      <Heading>{data.score ?? "—"}</Heading>
      <StatusTag variant={review ? "warning" : "default"}>{data.band}</StatusTag>
      <DescriptionList direction="column">
        <DescriptionListItem label="Confidence"><Text>{data.confidence}</Text></DescriptionListItem>
        <DescriptionListItem label="Evaluated"><Text>{new Date(data.evaluatedAt).toLocaleString()}</Text></DescriptionListItem>
        <DescriptionListItem label="Score version"><Text>{data.scoreVersion}</Text></DescriptionListItem>
      </DescriptionList>
    </Flex>
    {review && <Alert title="Manual review required" variant="warning">The available context remains visible below.</Alert>}
    <Divider />
    <Heading>Why now</Heading>
    {data.drivers.length ? data.drivers.map((driver, index) => <Flex key={`${driver.text}-${index}`} direction="column" gap="extra-small">
      <Text format={{ fontWeight: "demibold" }}>{driver.text}</Text>
      {driver.sources.map((source, sourceIndex) => <Text key={`${source.name}-${sourceIndex}`}>
        Source: {source.url ? <Link href={source.url}>{source.name}</Link> : source.name}
      </Text>)}
    </Flex>) : <Text>No approved score drivers are available.</Text>}
    <Heading>Grounded hook</Heading>
    <Text>{data.hook}</Text>
    <Divider />
    <Heading>Data quality</Heading>
    <DescriptionList direction="column">
      <DescriptionListItem label="Review reasons"><Text>{list(data.dataQuality.manualReview)}</Text></DescriptionListItem>
      <DescriptionListItem label="Missing"><Text>{list(data.dataQuality.missing)}</Text></DescriptionListItem>
      <DescriptionListItem label="Stale"><Text>{list(data.dataQuality.stale)}</Text></DescriptionListItem>
      <DescriptionListItem label="Conflicts"><Text>{list(data.dataQuality.conflicts)}</Text></DescriptionListItem>
      <DescriptionListItem label="Failed sources"><Text>{list(data.dataQuality.failedSources.map(({ source, status }) => `${source} (${status})`))}</Text></DescriptionListItem>
    </DescriptionList>
    <Heading>Writeback</Heading>
    <DescriptionList direction="column">
      <DescriptionListItem label="Status"><Text>{data.writeback.status}</Text></DescriptionListItem>
      <DescriptionListItem label="Reason"><Text>{data.writeback.reason}</Text></DescriptionListItem>
    </DescriptionList>
    <Divider />
    <Text>Select what you did or plan to do. ContextAI records the selection; it does not execute it.</Text>
    <ToggleGroup
      toggleType="radioButtonList"
      name="observed-rep-action"
      label="Observed rep action"
      options={actionOptions.map((option) => ({ ...option, readonly: saving !== null }))}
      value={actionType}
      onChange={(checkedOrValue: string | boolean, selectedValue?: string) => setActionType((selectedValue ?? (typeof checkedOrValue === "string" ? checkedOrValue : undefined)) as ActionType | undefined)}
    />
    <Heading>Recommendation</Heading>
    {review && <Text>Accept is unavailable until manual review is resolved.</Text>}
    <Flex direction="column" gap="extra-small">
      <LoadingButton variant="primary" loading={saving === "accepted"} disabled={saving !== null || review} onClick={() => disposition("accepted")}>Accept</LoadingButton>
      <LoadingButton loading={saving === "overridden"} disabled={saving !== null} onClick={() => disposition("overridden")}>Override</LoadingButton>
      <LoadingButton loading={saving === "ignored"} disabled={saving !== null} onClick={() => disposition("ignored")}>Ignore</LoadingButton>
    </Flex>
  </Flex>;
}
