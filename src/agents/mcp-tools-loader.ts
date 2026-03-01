/**
 * MCP Tools Loader - Load MCP tools via mcporter and convert to ToolDefinition format
 */

import { spawn } from "child_process";
import type { ToolDefinition, AgentToolResult } from "@mariozechner/pi-coding-agent";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import { jsonResult } from "./tools/common.js";
import { logDebug, logError, logInfo } from "../logger.js";

interface McporterTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McporterServer {
  name: string;
  status: string;
  tools: McporterTool[];
}

interface McporterListResult {
  servers: McporterServer[];
}

/**
 * Execute mcporter command and return JSON result
 */
async function execMcporter(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // On Windows, need to use shell: true to find mcporter in PATH
    const child = spawn("mcporter", args, {
      shell: true,
      timeout: 30000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`mcporter failed with code ${code}: ${stderr}`));
        return;
      }

      try {
        // Parse JSON from stdout (may have non-JSON prefix/suffix)
        const lines = stdout.split("\n");
        let jsonStart = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().startsWith("{") || lines[i].trim().startsWith("[")) {
            jsonStart = i;
            break;
          }
        }

        if (jsonStart === -1) {
          reject(new Error(`No JSON found in mcporter output: ${stdout}`));
          return;
        }

        const jsonText = lines.slice(jsonStart).join("\n");
        resolve(JSON.parse(jsonText));
      } catch (err) {
        reject(new Error(`Failed to parse mcporter output: ${err}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Execute mcporter call to invoke an MCP tool
 */
export async function callMcpTool(
  serverName: string,
  toolName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const args = ["call", `${serverName}.${toolName}`];

  // Add params as key=value arguments
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      args.push(`${key}=${JSON.stringify(value)}`);
    }
  }

  logInfo(`[mcp-tools] Calling ${serverName}.${toolName} with params: ${JSON.stringify(params)}`);
  const result = await execMcporter(args);
  logInfo(`[mcp-tools] Result: ${JSON.stringify(result)}`);
  return result;
}

/**
 * Load MCP tools from mcporter and convert to ClientToolDefinition format
 */
export async function loadMcpToolsAsClientTools(): Promise<ClientToolDefinition[]> {
  try {
    const result = (await execMcporter(["list", "--json"])) as McporterListResult;
    const clientTools: ClientToolDefinition[] = [];

    for (const server of result.servers ?? []) {
      if (server.status !== "ok") {
        logDebug(`[mcp-tools] Skipping server ${server.name} with status ${server.status}`);
        continue;
      }

      for (const tool of server.tools ?? []) {
        const toolName = `${server.name}__${tool.name}`;
        clientTools.push({
          type: "function",
          function: {
            name: toolName,
            description: tool.description ?? `MCP tool: ${server.name}/${tool.name}`,
            parameters: (tool.inputSchema as Record<string, unknown>) ?? {
              type: "object",
              properties: {},
            },
          },
        });
      }
    }

    logDebug(`[mcp-tools] Loaded ${clientTools.length} MCP tools from ${result.servers?.length ?? 0} servers`);
    return clientTools;
  } catch (err) {
    logError(`[mcp-tools] Failed to load MCP tools: ${err}`);
    return [];
  }
}

/**
 * Load MCP tools and convert to ToolDefinition format (with actual execution)
 */
export async function loadMcpToolsAsToolDefinitions(): Promise<ToolDefinition[]> {
  try {
    const result = (await execMcporter(["list", "--json"])) as McporterListResult;
    const tools: ToolDefinition[] = [];

    for (const server of result.servers ?? []) {
      if (server.status !== "ok") {
        logDebug(`[mcp-tools] Skipping server ${server.name} with status ${server.status}`);
        continue;
      }

      for (const tool of server.tools ?? []) {
        const toolName = `${server.name}__${tool.name}`;
        const serverName = server.name;
        const mcpToolName = tool.name;
        const inputSchema = tool.inputSchema;

        logInfo(`[mcp-tools] Tool ${toolName} inputSchema: ${JSON.stringify(inputSchema)}`);

        tools.push({
          name: toolName,
          label: toolName,
          description: tool.description ?? `MCP tool: ${server.name}/${tool.name}`,
          parameters: (inputSchema as ToolDefinition["parameters"]) ?? {
            type: "object",
            properties: {},
          },
          execute: async (
            toolCallId: string,
            params: unknown,
            signal: AbortSignal | undefined,
            context: unknown,
            extensionContext: unknown,
          ): Promise<AgentToolResult<unknown>> => {
            try {
              const result = await callMcpTool(serverName, mcpToolName, params as Record<string, unknown>);
              return jsonResult(result);
            } catch (err) {
              return jsonResult({ error: String(err) });
            }
          },
        } satisfies ToolDefinition);
      }
    }

    logInfo(`[mcp-tools] Loaded ${tools.length} MCP tool definitions`);
    return tools;
  } catch (err) {
    logError(`[mcp-tools] Failed to load MCP tools: ${err}`);
    return [];
  }
}

/**
 * Check if a tool name is an MCP tool (format: server__tool)
 */
export function isMcpToolName(toolName: string): boolean {
  return toolName.includes("__");
}

/**
 * Parse MCP tool name to server and tool
 */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  const parts = toolName.split("__");
  if (parts.length !== 2) {
    return null;
  }
  return { server: parts[0], tool: parts[1] };
}
