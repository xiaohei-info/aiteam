/**
 * 「让员工帮我装」的消息组装。单独成文件：纯函数，可测，也不让 .tsx 进入测试运行器。
 */
export function composeCapabilityRequestMessage(input: { requirement: string; link: string; json: string }): string {
  const lines = ['请帮我安装一个我需要的能力（装在我个人名下，只在本机）。', '', `我的需求：${input.requirement.trim()}`]
  const link = input.link.trim()
  if (link) lines.push('', `链接：${link}`)
  const json = input.json.trim()
  if (json) lines.push('', `配置 JSON：\n${json}`)
  lines.push('', '要求：先判断该装技能还是 MCP；来源可以是 ClawHub、GitHub、公开网址或粘贴的内容，不做限制；装之前先发 capability_install 让我批准。')
  return lines.join('\n')
}
