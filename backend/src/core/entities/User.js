// core/entities/User.js
export class User {
  constructor(data = {}) {
    this.id = data.id;
    this.wikidotInfo = data.wikidotInfo || {};
    this.statistics = data.statistics || {};
    this.isActive = data.isActive ?? true;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  get name() {
    return this.wikidotInfo?.username;
  }

  get displayName() {
    return this.wikidotInfo?.displayName || this.name;
  }

  get avatarUrl() {
    return this.wikidotInfo?.avatarUrl;
  }

  get joinDate() {
    return this.wikidotInfo?.since;
  }

  get totalVotes() {
    return this.statistics?.totalVotes || 0;
  }

  get totalPages() {
    return this.statistics?.totalPages || 0;
  }


  updateStatistics(stats) {
    this.statistics = { ...this.statistics, ...stats };
    this.updatedAt = new Date();
  }

  toJSON() {
    return {
      id: this.id,
      wikidotInfo: this.wikidotInfo,
      statistics: this.statistics,
      isActive: this.isActive,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}