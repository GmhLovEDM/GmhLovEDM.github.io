---
title: "LangChain Backend in Practice: Building an LLM Application Service"
tag: python
description: An in-depth guide to using LangChain to build production-grade LLM application backends, including chain calls, memory management, and tool integration.
date: "2025-04-20T08:00:00.000Z"
---

## Goal

This article aims to help developers master the core concepts and practical techniques of using LangChain to build LLM application backends, including chain calls, memory management, tool integration, and production deployment.

## Background

LangChain is the most popular LLM application development framework, providing standardized interfaces to connect various LLMs, vector databases, and tools. Using LangChain can quickly build complex LLM applications.

### LangChain Core Concepts

1. **Models**: Unified interface for LLM models
2. **Prompts**: Prompt template management
3. **Chains**: Chain call combinations
4. **Memory**: Conversation memory management
5. **Tools**: External tool integration
6. **Agents**: Intelligent agents

## 1. Environment Setup

### Install Dependencies

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate

# Install LangChain
pip install langchain langchain-openai langchain-community

# Install other dependencies
pip install python-dotenv faiss-cpu
```

### Configuration

```python
# config.py
import os
from dotenv import load_dotenv

load_dotenv()

# OpenAI configuration
os.environ["OPENAI_API_KEY"] = os.getenv("OPENAI_API_KEY")

# LangChain configuration
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_PROJECT"] = "my-llm-app"
```

## 2. Basic Chain Calls

### LLM Chain

```python
# basic_chain.py
from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate
from langchain.schema.output_parser import StrOutputParser

# Initialize LLM
llm = ChatOpenAI(model="gpt-4", temperature=0.7)

# Create prompt template
prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a professional {role}, please answer questions in a {style} style."),
    ("user", "{question}")
])

# Create chain
chain = prompt | llm | StrOutputParser()

# Call chain
result = chain.invoke({
    "role": "technical consultant",
    "style": "professional and easy to understand",
    "question": "What is microservices architecture?"
})

print(result)
```

### Multi-step Chain

```python
# multi_step_chain.py
from langchain.prompts import ChatPromptTemplate
from langchain.schema.output_parser import StrOutputParser

# Step 1: Generate outline
outline_prompt = ChatPromptTemplate.from_template(
    "Generate a detailed outline for the following topic: {topic}"
)

# Step 2: Expand content
expand_prompt = ChatPromptTemplate.from_template(
    "Expand each section based on the following outline:\n{outline}"
)

# Step 3: Generate summary
summary_prompt = ChatPromptTemplate.from_template(
    "Generate a brief summary for the following content:\n{content}"
)

# Create multi-step chain
chain = (
    {"outline": outline_prompt | llm | StrOutputParser()}
    | {"content": lambda x: expand_prompt.format_prompt(**x)}
    | {"summary": summary_prompt | llm | StrOutputParser()}
)

result = chain.invoke({"topic": "Python async programming"})
```

## 3. Memory Management

### Conversation Memory

```python
# chat_memory.py
from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.memory import ConversationBufferWindowMemory
from langchain.schema.runnable import RunnablePassthrough
from langchain.schema.output_parser import StrOutputParser

# Initialize
llm = ChatOpenAI(model="gpt-4")
memory = ConversationBufferWindowMemory(
    k=10,  // Keep last 10 rounds of conversation
    return_messages=True,
    memory_key="history"
)

# Prompt template
prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a helpful assistant."),
    MessagesPlaceholder(variable_name="history"),
    ("user", "{input}")
])

# Create chain
def load_memory(inputs):
    return memory.load_memory_variables({})["history"]

chain = (
    {"history": load_memory, "input": RunnablePassthrough()}
    | prompt
    | llm
    | StrOutputParser()
)

# Conversation loop
def chat(user_input: str) -> str:
    response = chain.invoke({"input": user_input})
    memory.save_context({"input": user_input}, {"output": response})
    return response

# Test
print(chat("My name is Zhang San"))
print(chat("What is my name?"))  // Should remember the name
```

### Persistent Memory

```python
# persistent_memory.py
from langchain.memory import ConversationBufferMemory
from langchain.storage import LocalFileStore
from langchain.memory.chat_message_histories import FileChatMessageHistory

// Use file storage for memory
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

## 4. Tool Integration

### Custom Tools

```python
# tools.py
from langchain.tools import tool
import requests

@tool
def search_web(query: str) -> str:
    """Search the web for information"""
    // Here you can connect to a real search API
    return f"Search results: Information about '{query}'..."

@tool
def calculate(expression: str) -> str:
    """Calculate mathematical expression"""
    try:
        result = eval(expression)
        return str(result)
    except Exception as e:
        return f"Calculation error: {str(e)}"

@tool
def get_weather(city: str) -> str:
    """Get city weather"""
    // Here you can connect to a real weather API
    return f"{city}: Sunny, 25°C"
```

### Agent

```python
# agent.py
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_openai_tools_agent
from langchain.prompts import ChatPromptTemplate, MessagesPlaceholder

// Initialize
llm = ChatOpenAI(model="gpt-4")

// Define tools
tools = [search_web, calculate, get_weather]

// Prompt
prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a helpful assistant that can use tools to answer questions."),
    MessagesPlaceholder(variable_name="chat_history", optional=True),
    ("user", "{input}"),
    MessagesPlaceholder(variable_name="agent_scratchpad"),
])

// Create Agent
agent = create_openai_tools_agent(llm, tools, prompt)
agent_executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

// Usage
result = agent_executor.invoke({
    "input": "How is the weather in Beijing today? Also calculate 123 * 456 for me"
})
```

## 5. RAG Implementation

### Document Loading and Splitting

```python
# rag.py
from langchain_community.document_loaders import TextLoader, PyPDFLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import FAISS
from langchain.prompts import ChatPromptTemplate
from langchain.schema.output_parser import StrOutputParser
from langchain.schema.runnable import RunnablePassthrough

// Load documents
def load_documents(file_path: str):
    if file_path.endswith('.pdf'):
        loader = PyPDFLoader(file_path)
    else:
        loader = TextLoader(file_path)
    
    documents = loader.load()
    
    // Split documents
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=200,
        length_function=len,
    )
    
    return text_splitter.split_documents(documents)

// Create vector store
def create_vector_store(documents):
    embeddings = OpenAIEmbeddings()
    vector_store = FAISS.from_documents(documents, embeddings)
    return vector_store

// RAG chain
def create_rag_chain(vector_store):
    retriever = vector_store.as_retriever(
        search_type="similarity",
        search_kwargs={"k": 3}
    )
    
    prompt = ChatPromptTemplate.from_template("""
    Answer questions based on the following context. If there is no relevant information in the context, say you don't know.
    
    Context:
    {context}
    
    Question: {question}
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

// Usage
documents = load_documents("knowledge_base.pdf")
vector_store = create_vector_store(documents)
rag_chain = create_rag_chain(vector_store)

answer = rag_chain.invoke("What is machine learning?")
print(answer)
```

## 6. Production Deployment

### FastAPI Service

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

// Request model
class ChatRequest(BaseModel):
    messages: List[dict]
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = 1000

class ChatResponse(BaseModel):
    response: str
    usage: dict

// Routes
@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    try {
        // Create chain
        chain = create_chat_chain(request.temperature)
        
        // Call
        result = chain.invoke({
            "messages": request.messages
        })
        
        return ChatResponse(
            response=result["response"],
            usage=result["usage"]
        )
    } catch Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/rag")
async def rag_query(question: str, document_id: str):
    try {
        // Load document vector store
        vector_store = load_vector_store(document_id)
        chain = create_rag_chain(vector_store)
        
        answer = chain.invoke(question)
        return {"answer": answer}
    } catch Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/health")
async def health():
    return {"status": "healthy"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

### Streaming Response

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
        ("system", "You are a helpful assistant."),
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

## 7. Error Handling and Retry

```python
# error_handling.py
from langchain.schema.runnable import RunnableLambda, RunnableConfig
from tenacity import retry, stop_after_attempt, wait_exponential

// Retry decorator
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=4, max=10)
)
def call_llm_with_retry(chain, inputs):
    return chain.invoke(inputs)

// Error handling chain
def with_error_handler(chain):
    def handle_error(error):
        print(f"Error: {error}")
        return {"response": "Sorry, something went wrong. Please try again later."}
    
    return chain | RunnableLambda(handle_error)

// Usage
safe_chain = with_error_handler(chain)
result = safe_chain.invoke({"input": "test"})
```

## 8. Monitoring and Logging

```python
# monitoring.py
import logging
from langchain.callbacks import StdOutCallbackHandler
from langchain.schema.runnable import RunnableConfig

// Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

// Custom callback
class MonitoringCallbackHandler:
    def on_llm_start(self, serialized, prompts, **kwargs):
        logger.info(f"LLM started with prompts: {prompts}")
    
    def on_llm_end(self, response, **kwargs):
        logger.info(f"LLM finished with response: {response}")
    
    def on_llm_error(self, error, **kwargs):
        logger.error(f"LLM error: {error}")

// Usage
config = RunnableConfig(
    callbacks=[MonitoringCallbackHandler()]
)

result = chain.invoke({"input": "test"}, config=config)
```

## Summary

LangChain provides a complete toolchain for building LLM applications.

| Component | Purpose | Recommendation |
|-----------|---------|----------------|
| Chains | Chain calls | 5/5 |
| Memory | Memory management | 4/5 |
| Tools | Tool integration | 5/5 |
| Agents | Intelligent agents | 4/5 |
| RAG | Knowledge retrieval | 5/5 |

**Recommendations**:

1. **Start Simple**: Implement basic chain calls first
2. **Progressive Complexity**: Gradually add memory, tools, RAG
3. **Focus on Production**: Error handling, monitoring, logging are important
4. **Thorough Testing**: LLM output is non-determinant, requires thorough testing
5. **Continuous Optimization**: Tune based on user feedback

LangChain is a powerful tool for building LLM applications. Mastering it will enable you to quickly build various AI applications. This practical guide will help you get started with LangChain.
