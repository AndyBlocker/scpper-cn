# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

SCPPER-CN 是一个基于 CROM GraphQL API v2 的企业级数据同步和分析系统，专门用于 SCP 基金会中文分部的数据管理。项目采用模块化架构，支持页面、用户、投票记录等数据的全量和增量同步，具备完整的数据分析和质量评估功能。

## 技术知识点

### GraphQL API Rate Limit 特性
- **双重限制系统**: CROM API v2有两个不同的限制机制
  - GraphQL查询复杂度限制: ≤1000 complexity per request
  - Rate Limit配额: 300,000 points per 5-minute window (1000 pts/s refill)
- **分页成本**: GraphQL客户端返回的最大Page Size也是100，当first/last指定超过100时，会消耗对应的分数，但只返回100条信息。
- **批处理策略**: 使用950复杂度作为安全限制，智能分组确保不超过单请求限制
- **Nginx限流注意事项**: 大部分时候，容易先触发crom服务器的nginx限流，因此，在设计的时候，要尽量让一次request获得更多的信息，但另一方面也要满足每次request complexity < 1000的设计。

## 核心架构

[原有内容保持不变]