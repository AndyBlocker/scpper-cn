// core/entities/Page.js
export class Page {
  constructor(data = {}) {
    // Handle both GraphQL response format and database format
    if (data.wikidotId && data.url) {
      // GraphQL response format
      this.id = data.wikidotId;
      this.wikidotInfo = {
        wikidotPageName: this.extractPageNameFromUrl(data.url),
        wikidotId: data.wikidotId,
        title: data.title,
        rating: data.rating,
        voteCount: data.voteCount,
        category: data.category,
        tags: data.tags || [],
        createdAt: data.createdAt,
        revisionCount: data.revisionCount,
        commentCount: data.commentCount,
        isHidden: data.isHidden,
        isUserPage: data.isUserPage,
        thumbnailUrl: data.thumbnailUrl,
        url: data.url,
        source: data.source,
        textContent: data.textContent
      };
    } else {
      // Database format
      this.id = data.id;
      this.wikidotInfo = data.wikidotInfo || {};
    }

    this.translationOf = data.translationOf;
    this.alternateTitles = data.alternateTitles || [];
    this.attributions = data.attributions || [];
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.votes = data.votes || [];
    this.revisions = data.revisions || [];
  }

  extractPageNameFromUrl(url) {
    if (!url) return null;
    const match = url.match(/\/([^\/]+)(?:\?|$)/);
    return match ? match[1] : null;
  }

  get fullname() {
    return this.wikidotInfo?.wikidotPageName;
  }

  get title() {
    return this.wikidotInfo?.title;
  }

  get rating() {
    return this.votes.reduce((sum, vote) => sum + vote.value, 0);
  }

  get voteCount() {
    return this.votes.length;
  }


  toJSON() {
    return {
      id: this.id,
      wikidotInfo: this.wikidotInfo,
      translationOf: this.translationOf,
      alternateTitles: this.alternateTitles,
      attributions: this.attributions,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      votes: this.votes,
      revisions: this.revisions
    };
  }
}