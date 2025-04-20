---
title: "LangChain 后端实战：构建一个 LLM 应用服务"
tag: python
description: 深入讲解如何使用 LangChain 构建生产级 LLM 应用后端，包括链式调用、记忆管理和工具集成。
date: "2025-04-20T08:00:00.000Z"
---

## 目标

本文旨在帮助开发者掌握使用 LangChain 构建 LLM 应用后端的核心概念和实战技巧，包括链式调用、记忆管理、工具集成和生产部署。

## 背景

LangChain 是最流行的 LLM 应用开发框架，它提供了标准化的接口来连接各种 LLM、向量数据库和工具。使用 LangChain 可以快速构建复杂的 LLM 应用。

### LangChain 的核心概念

1. **Models**：LLM 模型的统一接口
2. **Prompts**：提示词模板管理
3. **Chains**：链式调用组合
4. **Memory**：对话记忆管理
5. **Tools**：外部工具集成
6. **Agents**：智能代理

## 一、环境搭建

### 安装依赖

```bash
# 创建虚拟环境
python -m venv venv
source venv/bin/activate

# 安装 LangChain
pip install langchain langchain-openai langchain-community

# 安装其他依赖
pip install python-dotenv faiss-cpu
```

### 配置

```python
# config.py
import os
from dotenv import load_dotenv

load_dotenv()

# OpenAI 配置
os.environ["OPENAI_API_KEY"] = os.getenv("OPENAI_API_KEY")

# LangChain 配置
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_PROJECT"] = "my-llm-app"
```

## 二、基础链式调用

### LLM Chain

```python
# basic_chain.py
from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate
from langchain.schema.output_parser import StrOutputParser

# 初始化 LLM
llm = ChatOpenAI(model="gpt-4", temperature=0.7)

# 创建提示词模板
prompt = ChatPromptTemplate.from_messages([
    ("system", "你是一个专业的{role}，请用{style}的风格回答问题。"),
    ("user", "{question}")
])

# 创建链
chain = prompt | llm | StrOutputParser()

# 调用链
result = chain.invoke({
    "role": "技术顾问",
    "style": "专业且易懂",
    "question": "什么是微服务架构？"
})

print(result)
```

### 多步链

```python
# multi_step_chain.py
from langchain.prompts import ChatPromptTemplate
from langchain.schema.output_parser import StrOutputParser

# 第一步：生成大纲
outline_prompt = ChatPromptTemplate.from_template(
    "为以下主题生成一个详细的大纲：{topic}"
)

# 第二步：展开内容
expand_prompt = ChatPromptTemplate.from_template(
    "根据以下大纲，展开每个部分的内容：\n{outline}"
)

# 第三步：生成总结
summary_prompt = ChatPromptTemplate.from_template(
    "为以下内容生成一个简短的总结：\n{content}"
)

# 创建多步链
chain = (
    {"outline": outline_prompt | llm | StrOutputParser()}
    | {"content": lambda x: expand_prompt.format_prompt(**x)}
    | {"summary": summary_prompt | llm | StrOutputParser()}
)

result = chain.invoke({"topic": "Python 异步编程"})
```

## 三、记忆管理

### 对话记忆

```python
# chat_memory.py
from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.memory import ConversationBufferWindowMemory
from langchain.schema.runnable import RunnablePassthrough
from langchain.schema.output_parser import StrOutputParser

# 初始化
llm = ChatOpenAI(model="gpt-4")
memory = ConversationBufferWindowMemory(
    k=10,  # 保留最近10轮对话
    return_messages=True,
    memory_key="history"
)

# 提示词模板
prompt = ChatPromptTemplate.from_messages([
    ("system", "你是一个有帮助的助手。"),
    MessagesPlaceholder(variable_name="history"),
    ("user", "{input}")
])

# 创建链
def load_memory(inputs):
    return memory.load_memory_variables({})["history"]

chain = (
    {"history": load_memory, "input": RunnablePassthrough()}
    | prompt
    | llm
    | StrOutputParser()
)

# 对话循环
def chat(user_input: str) -> str:
    response = chain.invoke({"input": user_input})
    memory.save_context({"input": user_input}, {"output": response})
    return response

# 测试
print(chat("我叫张三"))
print(chat("我叫什么名字？"))  # 应该记住名字
```

### 持久化记忆

```python
# persistent_memory.py
from langchain.memory import ConversationBufferMemory
from langchain.storage import LocalFileStore
from langchain.memory.chat_message_histories import FileChatMessageHistory

# 使用文件存储记忆
store = LocalFileStore("./memory")

def get_memory(user_id: str):
    history = FileChatMessageHistory(
        path=f"./memory/{user_id}.json"
    )
    return ConversationBufferMemory(
        memory_key="history",
        chat_memory=history,
        return_messages=True
    )
```

## 四、工具集成

### 自定义工具

```python
# tools.py
from langchain.tools import tool
import requests

@tool
def search_web(query: str) -> str:
    """搜索网页获取信息"""
    # 这里可以接入真实的搜索 API
    return f"搜索结果：关于 '{query}' 的信息..."

@tool
def calculate(expression: str) -> str:
    """计算数学表达式"""
    try:
        result = eval(expression)
        return str(result)
    except Exception as e:
        return f"计算错误：{str(e)}"

@tool
def get_weather(city: str) -> str:
    """获取城市天气"""
    # 这里可以接入真实的天气 API
    return f"{city}：晴天，25°C"
```

### Agent

```python
# agent.py
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_openai_tools_agent
from langchain.prompts import ChatPromptTemplate, MessagesPlaceholder

# 初始化
llm = ChatOpenAI(model="gpt-4")

# 定义工具
tools = [search_web, calculate, get_weather]

# 提示词
prompt = ChatPromptTemplate.from_messages([
    ("system", "你是一个有帮助的助手，可以使用工具来回答问题。"),
    MessagesPlaceholder(variable_name="chat_history", optional=True),
    ("user", "{input}"),
    MessagesPlaceholder(variable_name="agent_scratchpad"),
])

# 创建 Agent
agent = create_openai_tools_agent(llm, tools, prompt)
agent_executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

# 使用
result = agent_executor.invoke({
    "input": "今天北京天气怎么样？帮我计算一下 123 * 456"
})
```

## 五、RAG 实现

### 文档加载和分割

```python
# rag.py
from langchain_community.document_loaders import TextLoader, PyPDFLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import FAISS
from langchain.prompts import ChatPromptTemplate
from langchain.schema.output_parser import StrOutputParser
from langchain.schema.runnable import RunnablePassthrough

# 加载文档
def load_documents(file_path: str):
    if file_path.endswith('.pdf'):
        loader = PyPDFLoader(file_path)
    else:
        loader = TextLoader(file_path)
    
    documents = loader.load()
    
    # 分割文档
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=200,
        length_function=len,
    )
    
    return text_splitter.split_documents(documents)

# 创建向量存储
def create_vector_store(documents):
    embeddings = OpenAIEmbeddings()
    vector_store = FAISS.from_documents(documents, embeddings)
    return vector_store

# RAG 链
def create_rag_chain(vector_store):
    retriever = vector_store.as_retriever(
        search_type="similarity",
        search_kwargs={"k": 3}
    )
    
    prompt = ChatPromptTemplate.from_template("""
    基于以下上下文回答问题。如果上下文中没有相关信息，请说你不知道。
    
    上下文：
    {context}
    
    问题：{question}
    """)
    
    def format_docs(docs):
        return "\n\n".join(doc.page_content for doc in docs)
    
    chain = (
        {"context": retriever | format_docs, "question": RunnablePassthrough()}
        | prompt
        | llm
        | StrOutputParser()
    )
    
    return chain

# 使用
documents = load_documents("knowledge_base.pdf")
vector_store = create_vector_store(documents)
rag_chain = create_rag_chain(vector_store)

answer = rag_chain.invoke("什么是机器学习？")
print(answer)
```

## 六、生产部署

### FastAPI 服务

```python
# main.py
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import uvicorn

app = FastAPI(title="LLM API Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 请求模型
class ChatRequest(BaseModel):
    messages: List[dict]
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int = 1000

class ChatResponse(BaseModel):
    response: str
    usage: dict

# 路由
@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    try:
        # 创建链
        chain = create_chat_chain(request.temperature)
        
        # 调用
        result = chain.invoke({
            "messages": request.messages
        })
        
        return ChatResponse(
            response=result["response"],
            usage=result["usage"]
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/rag")
async def rag_query(question: str, document_id: str):
    try:
        # 加载文档的向量存储
        vector_store = load_vector_store(document_id)
        chain = create_rag_chain(vector_store)
        
        answer = chain.invoke(question)
        return {"answer": answer}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/health")
async def health():
    return {"status": "healthy"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.00.0", port=8000)
```

### 流式响应

```python
# streaming.py
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate
from langchain.schema.output_parser import StrOutputParser
import json

app = FastAPI()

async def generate_stream(messages):
    llm = ChatOpenAI(model="gpt-4", streaming=True)
    prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一个有帮助的助手。"),
        ("user", "{input}")
    ])
    
    chain = prompt | llm | StrOutputParser()
    
    async for chunk in chain.astream({"input": messages[-1]["content"]}):
        yield f"data: {json.dumps({'content': chunk})}\n\n"
    
    yield "data: [DONE]\n\n"

@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest):
    return StreamingResponse(
        generate_stream(request.messages),
        media_type="text/event-stream"
    )
```

## 七、错误处理和重试

```python
# error_handling.py
from langchain.schema.runnable import RunnableLambda, RunnableConfig
from tenacity import retry, stop_after_attempt, wait_exponential

# 重试装饰器
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=4, max=10)
)
def call_llm_with_retry(chain, inputs):
    return chain.invoke(inputs)

# 错误处理链
def with_error_handler(chain):
    def handle_error(error):
        print(f"Error: {error}")
        return {"response": "抱歉，出现了一些问题，请稍后重试。"}
    
    return chain | RunnableLambda(handle_error)

# 使用
safe_chain = with_error_handler(chain)
result = safe_chain.invoke({"input": "测试"})
```

## 八、监控和日志

```python
# monitoring.py
import logging
from langchain.callbacks import StdOutCallbackHandler
from langchain.schema.runnable import RunnableConfig

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 自定义回调
class MonitoringCallbackHandler:
    def on_llm_start(self, serialized, prompts, **kwargs):
        logger.info(f"LLM started with prompts: {prompts}")
    
    def on_llm_end(self, response, **kwargs):
        logger.info(f"LLM finished with response: {response}")
    
    def on_llm_error(self, error, **kwargs):
        logger.error(f"LLM error: {error}")

# 使用
config = RunnableConfig(
    callbacks=[MonitoringCallbackHandler()]
)

result = chain.invoke({"input": "测试"}, config=config)
```

## 总结

LangChain 提供了构建 LLM 应用的完整工具链。

| 组件 | 用途 | 推荐度 |
|------|------|--------|
| Chains | 链式调用 | 5/5 |
| Memory | 记忆管理 | 4/5 |
| Tools | 工具集成 | 5/5 |
| Agents | 智能代理 | 4/5 |
| RAG | 知识检索 | 5/5 |

**姐姐的建议**：

1. **从简单开始**：先实现基本链式调用
2. **渐进复杂**：逐步添加记忆、工具、RAG
3. **关注生产**：错误处理、监控、日志很重要
4. **测试充分**：LLM 输出不确定，需要充分测试
5. **持续优化**：根据用户反馈调优

LangChain 是构建 LLM 应用的强大工具，掌握它将让你能够快速构建各种 AI 应用。希望这篇实战指南能帮助宝宝们上手 LangChain。
