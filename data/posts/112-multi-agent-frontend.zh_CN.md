---
title: "Multi-Agent 前端编排：如何展示多个 AI Agent 的协作"
tag: ai
description: 设计和实现多 Agent 协作系统的前端展示，涵盖状态可视化、任务流编排与交互设计
date: "2025-08-08T10:00:00.000Z"
---

## 目标

单个 AI Agent 的能力有限，但在 Multi-Agent 系统中，多个专业化的 Agent 可以协作完成复杂任务。问题在于：如何在前端清晰地展示多个 Agent 的协作过程？用户需要看到每个 Agent 在做什么、任务如何分配、整体进度如何。本文将深入探讨 Multi-Agent 前端编排的设计与实现。

## 背景

### Multi-Agent 系统的典型场景

1. **软件开发**：产品经理 Agent → 设计师 Agent → 开发者 Agent → 测试 Agent
2. **内容创作**：研究 Agent → 写作 Agent → 编辑 Agent → SEO Agent
3. **数据分析**：数据收集 Agent → 清洗 Agent → 分析 Agent → 可视化 Agent

### 前端面临的挑战

- **状态复杂度**：N 个 Agent 的状态组合呈指数增长
- **并行展示**：多个 Agent 可能同时执行，需要并行展示
- **依赖关系**：Agent 之间可能存在依赖，需要展示任务流
- **错误传播**：一个 Agent 失败可能影响其他 Agent

## 多 Agent 状态模型

### 数据结构设计

```typescript
interface AgentState {
  id: string;
  name: string;
  role: string;
  status: 'idle' | 'thinking' | 'working' | 'waiting' | 'completed' | 'failed';
  currentTask?: string;
  progress?: number;
  result?: any;
  error?: string;
  dependencies: string[];
  subTasks: SubTask[];
}

interface SubTask {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress?: number;
}

interface TaskOrchestration {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  agents: AgentState[];
  taskGraph: TaskNode[];
  startTime: number;
  estimatedEndTime?: number;
  result?: any;
}

interface TaskNode {
  id: string;
  agentId: string;
  dependencies: string[];
  status: 'pending' | 'ready' | 'running' | 'completed' | 'failed';
}
```

### 状态管理

```typescript
import { create } from 'zustand';

interface MultiAgentStore {
  orchestration: TaskOrchestration | null;
  initialize: (config: TaskOrchestration) => void;
  updateAgentStatus: (agentId: string, status: AgentState['status']) => void;
  updateAgentProgress: (agentId: string, progress: number) => void;
  updateSubTask: (agentId: string, taskId: string, status: SubTask['status']) => void;
  setAgentResult: (agentId: string, result: any) => void;
  setAgentError: (agentId: string, error: string) => void;
}

const useMultiAgentStore = create<MultiAgentStore>((set) => ({
  orchestration: null,

  initialize: (config) => set({ orchestration: config }),

  updateAgentStatus: (agentId, status) =>
    set((state) => ({
      orchestration: state.orchestration
        ? {
            ...state.orchestration,
            agents: state.orchestration.agents.map((agent) =>
              agent.id === agentId ? { ...agent, status } : agent
            ),
          }
        : null,
    })),

  updateAgentProgress: (agentId, progress) =>
    set((state) => ({
      orchestration: state.orchestration
        ? {
            ...state.orchestration,
            agents: state.orchestration.agents.map((agent) =>
              agent.id === agentId ? { ...agent, progress } : agent
            ),
          }
        : null,
    })),

  updateSubTask: (agentId, taskId, status) =>
    set((state) => ({
      orchestration: state.orchestration
        ? {
            ...state.orchestration,
            agents: state.orchestration.agents.map((agent) =>
              agent.id === agentId
                ? {
                    ...agent,
                    subTasks: agent.subTasks.map((task) =>
                      task.id === taskId ? { ...task, status } : task
                    ),
                  }
                : agent
            ),
          }
        : null,
    })),

  setAgentResult: (agentId, result) =>
    set((state) => ({
      orchestration: state.orchestration
        ? {
            ...state.orchestration,
            agents: state.orchestration.agents.map((agent) =>
              agent.id === agentId
                ? { ...agent, status: 'completed', result }
                : agent
            ),
          }
        : null,
    })),

  setAgentError: (agentId, error) =>
    set((state) => ({
      orchestration: state.orchestration
        ? {
            ...state.orchestration,
            agents: state.orchestration.agents.map((agent) =>
              agent.id === agentId
                ? { ...agent, status: 'failed', error }
                : agent
            ),
          }
        : null,
    })),
}));
```

## 可视化组件

### Agent 状态卡片

```tsx
'use client';

import { AgentState } from '@/types/agent';

interface AgentCardProps {
  agent: AgentState;
  onClick?: () => void;
}

export function AgentCard({ agent, onClick }: AgentCardProps) {
  const statusConfig = {
    idle: { color: 'bg-gray-100', icon: '⏸️', label: '空闲' },
    thinking: { color: 'bg-yellow-100', icon: '💭', label: '思考中' },
    working: { color: 'bg-blue-100', icon: '⚡', label: '工作中' },
    waiting: { color: 'bg-orange-100', icon: '⏳', label: '等待中' },
    completed: { color: 'bg-green-100', icon: '✅', label: '已完成' },
    failed: { color: 'bg-red-100', icon: '❌', label: '失败' },
  };

  const config = statusConfig[agent.status];

  return (
    <div
      className={`rounded-lg border p-4 ${config.color} cursor-pointer transition-all hover:shadow-md`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xl">{config.icon}</span>
          <div>
            <h3 className="font-semibold">{agent.name}</h3>
            <p className="text-sm text-gray-600">{agent.role}</p>
          </div>
        </div>
        <span className={`px-2 py-1 rounded text-xs ${
          agent.status === 'working' ? 'bg-blue-200 animate-pulse' : ''
        }`}>
          {config.label}
        </span>
      </div>

      {agent.currentTask && (
        <p className="text-sm text-gray-700 mb-2 truncate">
          当前任务：{agent.currentTask}
        </p>
      )}

      {agent.progress !== undefined && (
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-blue-500 h-2 rounded-full transition-all duration-500"
            style={{ width: `${agent.progress}%` }}
          />
        </div>
      )}

      {agent.subTasks.length > 0 && (
        <div className="mt-3 space-y-1">
          {agent.subTasks.slice(0, 3).map((task) => (
            <div key={task.id} className="flex items-center text-xs">
              <span className="mr-2">
                {task.status === 'completed' ? '✓' : 
                 task.status === 'in_progress' ? '◉' : '○'}
              </span>
              <span className={task.status === 'completed' ? 'text-gray-500 line-through' : ''}>
                {task.description}
              </span>
            </div>
          ))}
          {agent.subTasks.length > 3 && (
            <p className="text-xs text-gray-500">
              还有 {agent.subTasks.length - 3} 个任务...
            </p>
          )}
        </div>
      )}

      {agent.error && (
        <div className="mt-2 p-2 bg-red-50 rounded text-sm text-red-700">
          {agent.error}
        </div>
      )}
    </div>
  );
}
```

### 任务流程图

```tsx
'use client';

import { TaskNode } from '@/types/agent';

interface TaskFlowProps {
  nodes: TaskNode[];
  onNodeClick?: (nodeId: string) => void;
}

export function TaskFlow({ nodes, onNodeClick }: TaskFlowProps) {
  const levels = buildLevels(nodes);

  return (
    <div className="p-4">
      {levels.map((level, levelIdx) => (
        <div key={levelIdx} className="flex justify-center gap-4 mb-4">
          {level.map((node) => (
            <TaskNodeCard
              key={node.id}
              node={node}
              onClick={() => onNodeClick?.(node.id)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function TaskNodeCard({ node, onClick }: { node: TaskNode; onClick: () => void }) {
  const statusColors = {
    pending: 'border-gray-300 bg-gray-50',
    ready: 'border-yellow-300 bg-yellow-50',
    running: 'border-blue-300 bg-blue-50 animate-pulse',
    completed: 'border-green-300 bg-green-50',
    failed: 'border-red-300 bg-red-50',
  };

  return (
    <div
      className={`border-2 rounded-lg p-3 min-w-[120px] cursor-pointer transition-all hover:shadow-md ${statusColors[node.status]}`}
      onClick={onClick}
    >
      <p className="text-sm font-medium text-center">{node.id}</p>
      <p className="text-xs text-gray-500 text-center capitalize">{node.status}</p>
    </div>
  );
}

function buildLevels(nodes: TaskNode[]): TaskNode[][] {
  const levels: TaskNode[][] = [];
  const visited = new Set<string>();

  function visit(node: TaskNode, level: number) {
    if (visited.has(node.id)) return;
    if (node.dependencies.some((dep) => !visited.has(dep))) return;

    visited.add(node.id);
    if (!levels[level]) levels[level] = [];
    levels[level].push(node);

    nodes.forEach((n) => {
      if (n.dependencies.includes(node.id)) {
        visit(n, level + 1);
      }
    });
  }

  nodes.filter((n) => n.dependencies.length === 0).forEach((n) => visit(n, 0));

  return levels;
}
```

### 实时通信面板

```tsx
'use client';

import { useState, useEffect, useRef } from 'react';

interface Message {
  id: string;
  agentId: string;
  agentName: string;
  type: 'log' | 'error' | 'result' | 'communication';
  content: string;
  timestamp: number;
}

interface CommunicationPanelProps {
  orchestrationId: string;
}

export function CommunicationPanel({ orchestrationId }: CommunicationPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const eventSource = new EventSource(
      `/api/agents/stream?orchestrationId=${orchestrationId}`
    );

    eventSource.onmessage = (event) => {
      const message: Message = JSON.parse(event.data);
      setMessages((prev) => [...prev, message]);
    };

    return () => eventSource.close();
  }, [orchestrationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const filteredMessages = messages.filter(
    (msg) => filter === 'all' || msg.agentId === filter || msg.type === filter
  );

  const uniqueAgents = [...new Set(messages.map((m) => m.agentId))];

  return (
    <div className="flex flex-col h-full border rounded-lg">
      <div className="border-b p-2 flex gap-2 overflow-x-auto">
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1 rounded text-sm ${
            filter === 'all' ? 'bg-blue-500 text-white' : 'bg-gray-100'
          }`}
        >
          全部
        </button>
        {uniqueAgents.map((agentId) => {
          const agent = messages.find((m) => m.agentId === agentId);
          return (
            <button
              key={agentId}
              onClick={() => setFilter(agentId)}
              className={`px-3 py-1 rounded text-sm whitespace-nowrap ${
                filter === agentId ? 'bg-blue-500 text-white' : 'bg-gray-100'
              }`}
            >
              {agent?.agentName || agentId}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {filteredMessages.map((msg) => (
          <div
            key={msg.id}
            className={`p-2 rounded text-sm ${
              msg.type === 'error'
                ? 'bg-red-50 text-red-700'
                : msg.type === 'communication'
                ? 'bg-purple-50 text-purple-700'
                : msg.type === 'result'
                ? 'bg-green-50 text-green-700'
                : 'bg-gray-50'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium text-xs">{msg.agentName}</span>
              <span className="text-xs text-gray-400">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <p className="whitespace-pre-wrap">{msg.content}</p>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
```

## 高级模式

### Agent 协作可视化

```tsx
'use client';

import { AgentState } from '@/types/agent';

interface CollaborationViewProps {
  agents: AgentState[];
}

export function CollaborationView({ agents }: CollaborationViewProps) {
  return (
    <div className="relative h-[400px]">
      {agents.map((agent, idx) => {
        const angle = (idx / agents.length) * 2 * Math.PI;
        const radius = 150;
        const x = 200 + radius * Math.cos(angle);
        const y = 200 + radius * Math.sin(angle);

        return (
          <div
            key={agent.id}
            className="absolute transform -translate-x-1/2 -translate-y-1/2"
            style={{ left: x, top: y }}
          >
            <AgentNode agent={agent} />
          </div>
        );
      })}

      <svg className="absolute inset-0 pointer-events-none">
        {agents.map((agent) =>
          agent.dependencies.map((depId) => {
            const fromAgent = agents.find((a) => a.id === depId);
            if (!fromAgent) return null;

            const fromIdx = agents.indexOf(fromAgent);
            const toIdx = agents.indexOf(agent);
            
            const fromAngle = (fromIdx / agents.length) * 2 * Math.PI;
            const toAngle = (toIdx / agents.length) * 2 * Math.PI;
            const radius = 150;

            return (
              <line
                key={`${depId}-${agent.id}`}
                x1={200 + radius * Math.cos(fromAngle)}
                y1={200 + radius * Math.sin(fromAngle)}
                x2={200 + radius * Math.cos(toAngle)}
                y2={200 + radius * Math.sin(toAngle)}
                stroke={agent.status === 'working' ? '#3b82f6' : '#94a3b8'}
                strokeWidth={2}
                strokeDasharray={agent.status === 'waiting' ? '5,5' : 'none'}
              />
            );
          })
        )}
      </svg>

      <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-center">
        <OverallProgress agents={agents} />
      </div>
    </div>
  );
}

function AgentNode({ agent }: { agent: AgentState }) {
  return (
    <div
      className={`w-20 h-20 rounded-full flex items-center justify-center border-2 ${
        agent.status === 'working'
          ? 'border-blue-500 bg-blue-50 animate-pulse'
          : agent.status === 'completed'
          ? 'border-green-500 bg-green-50'
          : agent.status === 'failed'
          ? 'border-red-500 bg-red-50'
          : 'border-gray-300 bg-gray-50'
      }`}
    >
      <div className="text-center">
        <p className="text-lg">
          {agent.status === 'working' ? '⚡' : 
           agent.status === 'completed' ? '✅' : 
           agent.status === 'failed' ? '❌' : '⏸️'}
        </p>
        <p className="text-xs font-medium truncate max-w-[60px]">
          {agent.name}
        </p>
      </div>
    </div>
  );
}

function OverallProgress({ agents }: { agents: AgentState[] }) {
  const completed = agents.filter((a) => a.status === 'completed').length;
  const total = agents.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className="text-center">
      <div className="relative w-16 h-16 mx-auto">
        <svg className="w-16 h-16 transform -rotate-90">
          <circle cx="32" cy="32" r="28" stroke="#e5e7eb" strokeWidth="4" fill="none" />
          <circle
            cx="32" cy="32" r="28"
            stroke="#3b82f6" strokeWidth="4" fill="none"
            strokeDasharray={`${progress * 1.76} 176`}
            className="transition-all duration-500"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-bold">{Math.round(progress)}%</span>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-1">{completed}/{total} 完成</p>
    </div>
  );
}
```

## 总结

Multi-Agent 前端编排的核心要点：

1. **清晰的状态模型**：定义 Agent、任务、协作关系的数据结构
2. **实时更新**：通过 SSE/WebSocket 实现状态实时同步
3. **可视化设计**：状态卡片、任务流程图、协作关系图
4. **交互设计**：过滤、详情查看、手动干预
5. **错误处理**：优雅展示错误信息，支持重试和回滚

Multi-Agent 系统是 AI 应用的重要发展方向，而前端的可视化和交互设计是用户体验的关键。掌握这些模式，你就能构建出直观、高效的 Multi-Agent 应用界面。