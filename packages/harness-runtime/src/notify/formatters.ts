// @ts-nocheck — 通知渠道载荷格式化(本仓自有实现;「按渠道产出平台形状的文本卡」的做法参考
// teamai-cli,MIT,致谢;strict 类型化列入 backlog)。类型指向本地 webhook.ts。
import type { WebhookPayload } from './webhook';

const SIGNED = 'LampGenie 通知';
const DIVIDER = '───────────────────';
const TIME_STYLE = 'zh-CN';

function headline(payload: WebhookPayload): { label: string; clock: string } {
  const label = EVENT_TITLES[payload.event] ?? payload.event;
  const clock = new Date(payload.timestamp).toLocaleString(TIME_STYLE, {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return { label, clock };
}

function metaLines(payload: WebhookPayload): string[] {
  const lines: string[] = [];
  if (payload.username) lines.push(`用户: ${payload.username}`);
  if (payload.tool) lines.push(`工具: ${payload.tool}`);
  return lines;
}

function detailLine(event: string, data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  if (event === 'push' || event === 'pull') {
    const resources = data.resources as Record<string, number> | undefined;
    if (!resources || typeof resources !== 'object') return null;
    const parts = Object.entries(resources)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind}: ${count}`);
    return parts.length ? `资源: ${parts.join(', ')}` : null;
  }
  if (event === 'skill-use') {
    const name = data.skillName;
    return typeof name === 'string' && name ? `技能: ${name}` : null;
  }
  if (event === 'session-start' || event === 'session-stop') {
    const sid = data.sessionId;
    return typeof sid === 'string' && sid ? `会话: ${sid.slice(0, 8)}…` : null;
  }
  return null;
}

const EVENT_TITLES: Record<string, string> = {
  'push': '推送完成',
  'pull': '拉取完成',
  'skill-use': '技能调用',
  'session-start': '会话开始',
  'session-stop': '会话结束',
  'webhook-test': '通知链路自检',
};

/** 飞书(Lark)群机器人文本卡。 */
export function formatFeishuMessage(payload: WebhookPayload): Record<string, unknown> {
  const { label, clock } = headline(payload);
  const lines = [`🤖 ${SIGNED}`, DIVIDER, `事件: ${label}`, ...metaLines(payload), `时间: ${clock}`];
  const detail = detailLine(payload.event, payload.data);
  if (detail) lines.push(detail);
  lines.push(DIVIDER);
  return { msg_type: 'text', content: { text: lines.join('\n') } };
}

/** 企业微信群机器人文本卡。 */
export function formatWecomMessage(payload: WebhookPayload): Record<string, unknown> {
  const { label, clock } = headline(payload);
  const lines = [`🤖 ${SIGNED}`, `事件: ${label}`, ...metaLines(payload), `时间: ${clock}`];
  const detail = detailLine(payload.event, payload.data);
  if (detail) lines.push(detail);
  return { msgtype: 'text', text: { content: lines.join('\n') } };
}

/** 通用 JSON 载荷(自建接收端直接消费字段)。 */
export function formatGenericJson(payload: WebhookPayload): Record<string, unknown> {
  return {
    event: payload.event,
    timestamp: payload.timestamp,
    tool: payload.tool,
    sessionId: payload.sessionId,
    cwd: payload.cwd,
    team: payload.team,
    username: payload.username,
    data: payload.data,
  };
}
