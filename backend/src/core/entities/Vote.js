// core/entities/Vote.js
export class Vote {
  constructor(data = {}) {
    this.id = data.id;
    this.user = data.user;
    this.page = data.page;
    this.value = data.value;
    this.createdAt = data.createdAt;
  }

  get isUpvote() {
    return this.value > 0;
  }

  get isDownvote() {
    return this.value < 0;
  }

  get isNeutral() {
    return this.value === 0;
  }


  toJSON() {
    return {
      id: this.id,
      user: this.user,
      page: this.page,
      value: this.value,
      createdAt: this.createdAt
    };
  }
}