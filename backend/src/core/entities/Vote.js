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

  validate() {
    if (!this.user?.id) throw new Error('Vote must have a user');
    if (!this.page?.id) throw new Error('Vote must have a page');
    if (typeof this.value !== 'number') throw new Error('Vote must have a numeric value');
    if (this.value < -1 || this.value > 1) throw new Error('Vote value must be between -1 and 1');
    return true;
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