// src/core/client/SimpleGraphQLClient.js
import { GraphQLClient } from './GraphQLClient.js';
import { CoreQueries } from '../graphql/CoreQueries.js';
import { Logger } from '../../utils/Logger.js';

export class SimpleGraphQLClient {
  constructor(endpoint = 'https://apiv2.crom.avn.sh/graphql') {
    this.client = new GraphQLClient(endpoint);
    this.queries = new CoreQueries();
  }

  async isHealthy() {
    try {
      const { query, variables } = this.queries.buildQuery('totalCount');
      await this.client.request(query, variables);
      return true;
    } catch (error) {
      Logger.error('Health check failed:', error.message);
      return false;
    }
  }

  async getPhaseAPages(options = {}) {
    try {
      const variables = this.queries.buildPhaseAVariables(options);
      const { query } = this.queries.buildQuery('phaseA', variables);
      
      const result = await this.client.request(query, variables);
      
      return {
        data: result.pages.edges.map(edge => edge.node),
        pageInfo: result.pages.pageInfo
      };
    } catch (error) {
      Logger.error('Phase A query failed:', error.message);
      throw error;
    }
  }

  async getPhaseBPages(options = {}) {
    try {
      const variables = this.queries.buildPhaseBVariables(options);
      const { query } = this.queries.buildQuery('phaseB', variables);
      
      const result = await this.client.request(query, variables);
      
      return {
        data: result.pages.edges.map(edge => edge.node),
        pageInfo: result.pages.pageInfo
      };
    } catch (error) {
      Logger.error('Phase B query failed:', error.message);
      throw error;
    }
  }

  async getPhaseCVotes(pageUrl, options = {}) {
    try {
      const variables = this.queries.buildPhaseCVariables(pageUrl, options);
      const { query } = this.queries.buildQuery('phaseC', variables);
      
      const result = await this.client.request(query, variables);
      
      if (!result.wikidotPage) {
        return { data: [], pageInfo: { hasNextPage: false } };
      }
      
      return {
        data: result.wikidotPage.fuzzyVoteRecords.edges.map(edge => edge.node),
        pageInfo: result.wikidotPage.fuzzyVoteRecords.pageInfo
      };
    } catch (error) {
      Logger.error('Phase C query failed:', error.message);
      throw error;
    }
  }

  async getTotalCount(filter = null) {
    try {
      const variables = { filter: filter || this.queries.buildScpCnFilter() };
      const { query } = this.queries.buildQuery('totalCount', variables);
      
      const result = await this.client.request(query, variables);
      
      return {
        hasPages: result.pages.pageInfo.hasNextPage || result.pages.edges?.length > 0
      };
    } catch (error) {
      Logger.error('Total count query failed:', error.message);
      throw error;
    }
  }

  async getUserByName(displayName) {
    try {
      const variables = { displayName };
      const { query } = this.queries.buildQuery('userByName', variables);
      
      const result = await this.client.request(query, variables);
      return result.wikidotUser;
    } catch (error) {
      Logger.error('User by name query failed:', error.message);
      throw error;
    }
  }

  async getUserById(wikidotId) {
    try {
      const variables = { wikidotId };
      const { query } = this.queries.buildQuery('userById', variables);
      
      const result = await this.client.request(query, variables);
      return result.wikidotUser;
    } catch (error) {
      Logger.error('User by ID query failed:', error.message);
      throw error;
    }
  }
}