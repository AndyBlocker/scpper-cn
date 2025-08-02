import { PrismaClient } from '@prisma/client';

export interface UpdateRequirement {
  phaseB: boolean;
  phaseC: boolean;
  reason: string;
}

export class PageService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  async needsUpdate(basicInfo: any): Promise<UpdateRequirement> {
    const page = await this.prisma.page.findUnique({
      where: { url: basicInfo.url },
      include: {
        versions: {
          where: { validTo: null },
          take: 1,
        },
      },
    });

    if (!page || page.versions.length === 0) {
      return {
        phaseB: true,
        phaseC: true,
        reason: 'New page - full sync required',
      };
    }

    const currentVersion = page.versions[0];
    let phaseB = false;
    let phaseC = false;
    const reasons: string[] = [];

    // Check if content needs updating (Phase B)
    if (
      currentVersion.title !== basicInfo.title ||
      currentVersion.rating !== basicInfo.rating ||
      !this.arraysEqual(currentVersion.tags, basicInfo.tags || [])
    ) {
      phaseB = true;
      reasons.push('metadata changed');
    }

    // Check if revisions/votes need updating (Phase C)
    if (
      currentVersion.revisionCount !== basicInfo.revisionCount ||
      currentVersion.voteCount !== basicInfo.voteCount
    ) {
      phaseC = true;
      reasons.push('revision/vote count changed');
    }

    // Check if page has been deleted/undeleted
    if (currentVersion.isDeleted !== (basicInfo.isDeleted || false)) {
      phaseB = true;
      phaseC = true;
      reasons.push('deletion status changed');
    }

    // Check if wikidotId changed (page revival/replacement)
    if (currentVersion.wikidotId !== basicInfo.wikidotId) {
      phaseB = true;
      phaseC = true;
      reasons.push('wikidot ID changed - possible page revival');
    }

    return {
      phaseB,
      phaseC,
      reason: reasons.length > 0 ? reasons.join(', ') : 'no update needed',
    };
  }

  async getLastRevisionTimestamp(url: string): Promise<Date | null> {
    const page = await this.prisma.page.findUnique({
      where: { url },
      include: {
        versions: {
          where: { validTo: null },
          include: {
            revisions: {
              orderBy: { timestamp: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    if (!page || !page.versions[0] || !page.versions[0].revisions[0]) {
      return null;
    }

    return page.versions[0].revisions[0].timestamp;
  }

  async getLastVoteTimestamp(url: string): Promise<Date | null> {
    const page = await this.prisma.page.findUnique({
      where: { url },
      include: {
        versions: {
          where: { validTo: null },
          include: {
            votes: {
              orderBy: { timestamp: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    if (!page || !page.versions[0] || !page.versions[0].votes[0]) {
      return null;
    }

    return page.versions[0].votes[0].timestamp;
  }

  async getProcessedUrls(): Promise<string[]> {
    const pages = await this.prisma.page.findMany({
      select: { url: true },
    });

    return pages.map(p => p.url);
  }

  async getUrlsNeedingPhaseB(): Promise<string[]> {
    const versions = await this.prisma.pageVersion.findMany({
      where: {
        validTo: null,
        textContent: null,
      },
      include: { page: true },
    });

    return versions.map(v => v.page.url);
  }

  async getUrlsNeedingPhaseC(): Promise<string[]> {
    const versions = await this.prisma.pageVersion.findMany({
      where: {
        validTo: null,
        OR: [
          { revisionCount: { gt: 0 }, revisions: { none: {} } },
          { voteCount: { gt: 0 }, votes: { none: {} } },
        ],
      },
      include: { page: true },
    });

    return versions.map(v => v.page.url);
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((val, i) => val === sortedB[i]);
  }

  async disconnect() {
    await this.prisma.$disconnect();
  }
}