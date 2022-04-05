/* eslint-disable @typescript-eslint/no-explicit-any */

import mongoose, {
  Schema, Model, Document, AnyObject,
} from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';
import uniqueValidator from 'mongoose-unique-validator';
import escapeStringRegexp from 'escape-string-regexp';
import nodePath from 'path';
import { getOrCreateModel, pagePathUtils, pathUtils } from '@growi/core';

import loggerFactory from '../../utils/logger';
import Crowi from '../crowi';
import { IPage } from '../../interfaces/page';
import { getPageSchema, extractToAncestorsPaths, populateDataToShowRevision } from './obsolete-page';
import { ObjectIdLike } from '~/server/interfaces/mongoose-utils';
import { PageRedirectModel } from './page-redirect';
import { IUser } from '~/interfaces/user';
import { Ref } from '~/interfaces/common';

const { addTrailingSlash } = pathUtils;
const { isTopPage, collectAncestorPaths } = pagePathUtils;

const logger = loggerFactory('growi:models:page');


/*
 * define schema
 */
const GRANT_PUBLIC = 1;
const GRANT_RESTRICTED = 2;
const GRANT_SPECIFIED = 3; // DEPRECATED
const GRANT_OWNER = 4;
const GRANT_USER_GROUP = 5;
const PAGE_GRANT_ERROR = 1;
const STATUS_PUBLISHED = 'published';
const STATUS_DELETED = 'deleted';

export interface PageDocument extends IPage, Document {}


type TargetAndAncestorsResult = {
  targetAndAncestors: PageDocument[]
  rootPage: PageDocument
}

export type CreateMethod = (path: string, body: string, user, options) => Promise<PageDocument & { _id: any }>
export interface PageModel extends Model<PageDocument> {
  [x: string]: any; // for obsolete methods
  createEmptyPagesByPaths(paths: string[], user: any | null, onlyMigratedAsExistingPages?: boolean, andFilter?): Promise<void>
  getParentAndFillAncestors(path: string, user): Promise<PageDocument & { _id: any }>
  findByIdsAndViewer(pageIds: ObjectIdLike[], user, userGroups?, includeEmpty?: boolean): Promise<PageDocument[]>
  findByPathAndViewer(path: string | null, user, userGroups?, useFindOne?: boolean, includeEmpty?: boolean): Promise<PageDocument[]>
  findTargetAndAncestorsByPathOrId(pathOrId: string): Promise<TargetAndAncestorsResult>
  findChildrenByParentPathOrIdAndViewer(parentPathOrId: string, user, userGroups?): Promise<PageDocument[]>
  findAncestorsChildrenByPathAndViewer(path: string, user, userGroups?): Promise<Record<string, PageDocument[]>>

  generateGrantCondition(
    user, userGroups, showAnyoneKnowsLink?: boolean, showPagesRestrictedByOwner?: boolean, showPagesRestrictedByGroup?: boolean,
  ): { $or: any[] }

  PageQueryBuilder: typeof PageQueryBuilder

  GRANT_PUBLIC
  GRANT_RESTRICTED
  GRANT_SPECIFIED
  GRANT_OWNER
  GRANT_USER_GROUP
  PAGE_GRANT_ERROR
  STATUS_PUBLISHED
  STATUS_DELETED
}

type IObjectId = mongoose.Types.ObjectId;
const ObjectId = mongoose.Schema.Types.ObjectId;

const schema = new Schema<PageDocument, PageModel>({
  parent: {
    type: ObjectId, ref: 'Page', index: true, default: null,
  },
  descendantCount: { type: Number, default: 0 },
  isEmpty: { type: Boolean, default: false },
  path: {
    type: String, required: true, index: true,
  },
  revision: { type: ObjectId, ref: 'Revision' },
  status: { type: String, default: STATUS_PUBLISHED, index: true },
  grant: { type: Number, default: GRANT_PUBLIC, index: true },
  grantedUsers: [{ type: ObjectId, ref: 'User' }],
  grantedGroup: { type: ObjectId, ref: 'UserGroup', index: true },
  creator: { type: ObjectId, ref: 'User', index: true },
  lastUpdateUser: { type: ObjectId, ref: 'User' },
  liker: [{ type: ObjectId, ref: 'User' }],
  seenUsers: [{ type: ObjectId, ref: 'User' }],
  commentCount: { type: Number, default: 0 },
  slackChannels: { type: String },
  pageIdOnHackmd: { type: String },
  revisionHackmdSynced: { type: ObjectId, ref: 'Revision' }, // the revision that is synced to HackMD
  hasDraftOnHackmd: { type: Boolean }, // set true if revision and revisionHackmdSynced are same but HackMD document has modified
  createdAt: { type: Date, default: new Date() },
  updatedAt: { type: Date, default: new Date() },
  deleteUser: { type: ObjectId, ref: 'User' },
  deletedAt: { type: Date },
}, {
  toJSON: { getters: true },
  toObject: { getters: true },
});
// apply plugins
schema.plugin(mongoosePaginate);
schema.plugin(uniqueValidator);

const hasSlash = (str: string): boolean => {
  return str.includes('/');
};

/*
 * Generate RegExp instance for one level lower path
 */
const generateChildrenRegExp = (path: string): RegExp => {
  // https://regex101.com/r/laJGzj/1
  // ex. /any_level1
  if (isTopPage(path)) return new RegExp(/^\/[^/]+$/);

  // https://regex101.com/r/mrDJrx/1
  // ex. /parent/any_child OR /any_level1
  return new RegExp(`^${path}(\\/[^/]+)\\/?$`);
};

class PageQueryBuilder {

  query: any;

  constructor(query, includeEmpty = false) {
    this.query = query;
    if (!includeEmpty) {
      this.query = this.query
        .and({
          $or: [
            { isEmpty: false },
            { isEmpty: null }, // for v4 compatibility
          ],
        });
    }
  }

  /**
   * Used for filtering the pages at specified paths not to include unintentional pages.
   * @param pathsToFilter The paths to have additional filters as to be applicable
   * @returns PageQueryBuilder
   */
  addConditionToFilterByApplicableAncestors(pathsToFilter: string[]) {
    this.query = this.query
      .and(
        {
          $or: [
            { path: '/' },
            { path: { $in: pathsToFilter }, grant: GRANT_PUBLIC, status: STATUS_PUBLISHED },
            { path: { $in: pathsToFilter }, parent: { $ne: null }, status: STATUS_PUBLISHED },
            { path: { $nin: pathsToFilter }, status: STATUS_PUBLISHED },
          ],
        },
      );

    return this;
  }

  addConditionToExcludeTrashed() {
    this.query = this.query
      .and({
        $or: [
          { status: null },
          { status: STATUS_PUBLISHED },
        ],
      });

    return this;
  }

  /**
   * generate the query to find the pages '{path}/*' and '{path}' self.
   * If top page, return without doing anything.
   */
  addConditionToListWithDescendants(path: string, option?) {
    // No request is set for the top page
    if (isTopPage(path)) {
      return this;
    }

    const pathNormalized = pathUtils.normalizePath(path);
    const pathWithTrailingSlash = addTrailingSlash(path);

    const startsPattern = escapeStringRegexp(pathWithTrailingSlash);

    this.query = this.query
      .and({
        $or: [
          { path: pathNormalized },
          { path: new RegExp(`^${startsPattern}`) },
        ],
      });

    return this;
  }

  /**
   * generate the query to find the pages '{path}/*' (exclude '{path}' self).
   * If top page, return without doing anything.
   */
  addConditionToListOnlyDescendants(path, option) {
    // No request is set for the top page
    if (isTopPage(path)) {
      return this;
    }

    const pathWithTrailingSlash = addTrailingSlash(path);

    const startsPattern = escapeStringRegexp(pathWithTrailingSlash);

    this.query = this.query
      .and({ path: new RegExp(`^${startsPattern}`) });

    return this;

  }

  addConditionToListOnlyAncestors(path) {
    const pathNormalized = pathUtils.normalizePath(path);
    const ancestorsPaths = extractToAncestorsPaths(pathNormalized);

    this.query = this.query
      .and({
        path: {
          $in: ancestorsPaths,
        },
      });

    return this;

  }

  /**
   * generate the query to find pages that start with `path`
   *
   * In normal case, returns '{path}/*' and '{path}' self.
   * If top page, return without doing anything.
   *
   * *option*
   *   Left for backward compatibility
   */
  addConditionToListByStartWith(path, option?) {
    // No request is set for the top page
    if (isTopPage(path)) {
      return this;
    }

    const startsPattern = escapeStringRegexp(path);

    this.query = this.query
      .and({ path: new RegExp(`^${startsPattern}`) });

    return this;
  }

  async addConditionForParentNormalization(user) {
    // determine UserGroup condition
    let userGroups;
    if (user != null) {
      const UserGroupRelation = mongoose.model('UserGroupRelation') as any; // TODO: Typescriptize model
      userGroups = await UserGroupRelation.findAllUserGroupIdsRelatedToUser(user);
    }

    const grantConditions: any[] = [
      { grant: null },
      { grant: GRANT_PUBLIC },
    ];

    if (user != null) {
      grantConditions.push(
        { grant: GRANT_OWNER, grantedUsers: user._id },
      );
    }

    if (userGroups != null && userGroups.length > 0) {
      grantConditions.push(
        { grant: GRANT_USER_GROUP, grantedGroup: { $in: userGroups } },
      );
    }

    this.query = this.query
      .and({
        $or: grantConditions,
      });

    return this;
  }

  async addConditionAsMigratablePages(user) {
    this.query = this.query
      .and({
        $or: [
          { grant: { $ne: GRANT_RESTRICTED } },
          { grant: { $ne: GRANT_SPECIFIED } },
        ],
      });
    this.addConditionAsNotMigrated();
    this.addConditionAsNonRootPage();
    this.addConditionToExcludeTrashed();
    await this.addConditionForParentNormalization(user);

    return this;
  }

  addConditionToFilteringByViewer(user, userGroups, showAnyoneKnowsLink = false, showPagesRestrictedByOwner = false, showPagesRestrictedByGroup = false) {
    const condition = generateGrantCondition(user, userGroups, showAnyoneKnowsLink, showPagesRestrictedByOwner, showPagesRestrictedByGroup);

    this.query = this.query
      .and(condition);

    return this;
  }

  addConditionToPagenate(offset, limit, sortOpt?) {
    this.query = this.query
      .sort(sortOpt).skip(offset).limit(limit); // eslint-disable-line newline-per-chained-call

    return this;
  }

  addConditionAsNonRootPage() {
    this.query = this.query.and({ path: { $ne: '/' } });

    return this;
  }

  addConditionAsNotMigrated() {
    this.query = this.query
      .and({ parent: null });

    return this;
  }

  addConditionAsMigrated() {
    this.query = this.query
      .and(
        {
          $or: [
            { parent: { $ne: null } },
            { path: '/' },
          ],
        },
      );

    return this;
  }

  /*
   * Add this condition when get any ancestor pages including the target's parent
   */
  addConditionToSortPagesByDescPath() {
    this.query = this.query.sort('-path');

    return this;
  }

  addConditionToSortPagesByAscPath() {
    this.query = this.query.sort('path');

    return this;
  }

  addConditionToMinimizeDataForRendering() {
    this.query = this.query.select('_id path isEmpty grant revision descendantCount');

    return this;
  }

  addConditionToListByPathsArray(paths) {
    this.query = this.query
      .and({
        path: {
          $in: paths,
        },
      });

    return this;
  }

  addConditionToListByPageIdsArray(pageIds) {
    this.query = this.query
      .and({
        _id: {
          $in: pageIds,
        },
      });

    return this;
  }

  addConditionToExcludeByPageIdsArray(pageIds) {
    this.query = this.query
      .and({
        _id: {
          $nin: pageIds,
        },
      });

    return this;
  }

  populateDataToList(userPublicFields) {
    this.query = this.query
      .populate({
        path: 'lastUpdateUser',
        select: userPublicFields,
      });
    return this;
  }

  populateDataToShowRevision(userPublicFields) {
    this.query = populateDataToShowRevision(this.query, userPublicFields);
    return this;
  }

  addConditionToFilteringByParentId(parentId) {
    this.query = this.query.and({ parent: parentId });
    return this;
  }

}

/**
 * Create empty pages if the page in paths didn't exist
 * @param onlyMigratedAsExistingPages Determine whether to include non-migrated pages as existing pages. If a page exists,
 * an empty page will not be created at that page's path.
 */
schema.statics.createEmptyPagesByPaths = async function(paths: string[], user: any | null, onlyMigratedAsExistingPages = true, filter?): Promise<void> {
  const aggregationPipeline: any[] = [];
  // 1. Filter by paths
  aggregationPipeline.push({ $match: { path: { $in: paths } } });
  // 2. Normalized condition
  if (onlyMigratedAsExistingPages) {
    aggregationPipeline.push({
      $match: {
        $or: [
          { parent: { $ne: null } },
          { path: '/' },
        ],
      },
    });
  }
  // 3. Add custom pipeline
  if (filter != null) {
    aggregationPipeline.push({ $match: filter });
  }
  // 4. Add grant conditions
  let userGroups = null;
  if (user != null) {
    const UserGroupRelation = mongoose.model('UserGroupRelation') as any;
    userGroups = await UserGroupRelation.findAllUserGroupIdsRelatedToUser(user);
  }
  const grantCondition = this.generateGrantCondition(user, userGroups);
  aggregationPipeline.push({ $match: grantCondition });

  // Run aggregation
  const existingPages = await this.aggregate(aggregationPipeline);


  const existingPagePaths = existingPages.map(page => page.path);
  // paths to create empty pages
  const notExistingPagePaths = paths.filter(path => !existingPagePaths.includes(path));

  // insertMany empty pages
  try {
    await this.insertMany(notExistingPagePaths.map(path => ({ path, isEmpty: true, creator: user })));
  }
  catch (err) {
    logger.error('Failed to insert empty pages.', err);
    throw err;
  }
};

schema.statics.createEmptyPage = async function(
    path: string, parent: any, creator: Ref<IUser>, descendantCount = 0, // TODO: improve type including IPage at https://redmine.weseek.co.jp/issues/86506
): Promise<PageDocument & { _id: any }> {
  if (parent == null) {
    throw Error('parent must not be null');
  }

  const Page = this;
  const page = new Page();
  page.path = path;
  page.isEmpty = true;
  page.parent = parent;
  page.descendantCount = descendantCount;
  page.creator = creator;

  return page.save();
};

/**
 * Replace an existing page with an empty page.
 * It updates the children's parent to the new empty page's _id.
 * @param exPage a page document to be replaced
 * @returns Promise<void>
 */
schema.statics.replaceTargetWithPage = async function(exPage, operator: Ref<IUser>, pageToReplaceWith?, deleteExPageIfEmpty = false) {
  // find parent
  const parent = await this.findOne({ _id: exPage.parent });
  if (parent == null) {
    throw Error('parent to update does not exist. Prepare parent first.');
  }

  // create empty page at path
  const newTarget = pageToReplaceWith == null ? await this.createEmptyPage(exPage.path, parent, operator, exPage.descendantCount) : pageToReplaceWith;

  // find children by ex-page _id
  const children = await this.find({ parent: exPage._id });

  // bulkWrite
  const operationForNewTarget = {
    updateOne: {
      filter: { _id: newTarget._id },
      update: {
        parent: parent._id,
      },
    },
  };
  const operationsForChildren = {
    updateMany: {
      filter: {
        _id: { $in: children.map(d => d._id) },
      },
      update: {
        parent: newTarget._id,
      },
    },
  };

  await this.bulkWrite([operationForNewTarget, operationsForChildren]);

  const isExPageEmpty = exPage.isEmpty;
  if (deleteExPageIfEmpty && isExPageEmpty) {
    await this.deleteOne({ _id: exPage._id });
    logger.warn('Deleted empty page since it was replaced with another page.');
  }

  return this.findById(newTarget._id);
};

/**
 * Find parent or create parent if not exists.
 * It also updates parent of ancestors
 * @param path string
 * @returns Promise<PageDocument>
 */
schema.statics.getParentAndFillAncestors = async function(path: string, user): Promise<PageDocument> {
  const parentPath = nodePath.dirname(path);

  const builder1 = new PageQueryBuilder(this.find({ path: parentPath }), true);
  const pagesCanBeParent = await builder1
    .addConditionAsMigrated()
    .query
    .exec();

  if (pagesCanBeParent.length >= 1) {
    return pagesCanBeParent[0]; // the earliest page will be the result
  }

  /*
   * Fill parents if parent is null
   */
  const ancestorPaths = collectAncestorPaths(path); // paths of parents need to be created

  // just create ancestors with empty pages
  await this.createEmptyPagesByPaths(ancestorPaths, user);

  // find ancestors
  const builder2 = new PageQueryBuilder(this.find(), true);

  // avoid including not normalized pages
  builder2.addConditionToFilterByApplicableAncestors(ancestorPaths);

  const ancestors = await builder2
    .addConditionToListByPathsArray(ancestorPaths)
    .addConditionToSortPagesByDescPath()
    .query
    .exec();

  const ancestorsMap = new Map(); // Map<path, page>
  ancestors.forEach(page => !ancestorsMap.has(page.path) && ancestorsMap.set(page.path, page)); // the earlier element should be the true ancestor

  // bulkWrite to update ancestors
  const nonRootAncestors = ancestors.filter(page => !isTopPage(page.path));
  const operations = nonRootAncestors.map((page) => {
    const parentPath = nodePath.dirname(page.path);
    return {
      updateOne: {
        filter: {
          _id: page._id,
        },
        update: {
          parent: ancestorsMap.get(parentPath)._id,
        },
      },
    };
  });
  await this.bulkWrite(operations);

  const createdParent = ancestorsMap.get(parentPath);

  return createdParent;
};

// Utility function to add viewer condition to PageQueryBuilder instance
const addViewerCondition = async(queryBuilder: PageQueryBuilder, user, userGroups = null): Promise<void> => {
  let relatedUserGroups = userGroups;
  if (user != null && relatedUserGroups == null) {
    const UserGroupRelation: any = mongoose.model('UserGroupRelation');
    relatedUserGroups = await UserGroupRelation.findAllUserGroupIdsRelatedToUser(user);
  }

  queryBuilder.addConditionToFilteringByViewer(user, relatedUserGroups, false);
};

/*
 * Find pages by ID and viewer.
 */
schema.statics.findByIdsAndViewer = async function(pageIds: string[], user, userGroups?, includeEmpty?: boolean): Promise<PageDocument[]> {
  const baseQuery = this.find({ _id: { $in: pageIds } });
  const queryBuilder = new PageQueryBuilder(baseQuery, includeEmpty);

  await addViewerCondition(queryBuilder, user, userGroups);

  return queryBuilder.query.exec();
};

/*
 * Find a page by path and viewer. Pass false to useFindOne to use findOne method.
 */
schema.statics.findByPathAndViewer = async function(
    path: string | null, user, userGroups = null, useFindOne = true, includeEmpty = false,
): Promise<PageDocument | PageDocument[] | null> {
  if (path == null) {
    throw new Error('path is required.');
  }

  const baseQuery = useFindOne ? this.findOne({ path }) : this.find({ path });
  const queryBuilder = new PageQueryBuilder(baseQuery, includeEmpty);

  await addViewerCondition(queryBuilder, user, userGroups);

  return queryBuilder.query.exec();
};


/*
 * Find all ancestor pages by path. When duplicate pages found, it uses the oldest page as a result
 * The result will include the target as well
 */
schema.statics.findTargetAndAncestorsByPathOrId = async function(pathOrId: string, user, userGroups): Promise<TargetAndAncestorsResult> {
  let path;
  if (!hasSlash(pathOrId)) {
    const _id = pathOrId;
    const page = await this.findOne({ _id });

    path = page == null ? '/' : page.path;
  }
  else {
    path = pathOrId;
  }

  const ancestorPaths = collectAncestorPaths(path);
  ancestorPaths.push(path); // include target

  // Do not populate
  const queryBuilder = new PageQueryBuilder(this.find(), true);
  await addViewerCondition(queryBuilder, user, userGroups);

  const _targetAndAncestors: PageDocument[] = await queryBuilder
    .addConditionAsMigrated()
    .addConditionToListByPathsArray(ancestorPaths)
    .addConditionToMinimizeDataForRendering()
    .addConditionToSortPagesByDescPath()
    .query
    .lean()
    .exec();

  // no same path pages
  const ancestorsMap = new Map<string, PageDocument>();
  _targetAndAncestors.forEach(page => ancestorsMap.set(page.path, page));
  const targetAndAncestors = Array.from(ancestorsMap.values());
  const rootPage = targetAndAncestors[targetAndAncestors.length - 1];

  return { targetAndAncestors, rootPage };
};

/*
 * Find all children by parent's path or id. Using id should be prioritized
 */
schema.statics.findChildrenByParentPathOrIdAndViewer = async function(parentPathOrId: string, user, userGroups = null): Promise<PageDocument[]> {
  let queryBuilder: PageQueryBuilder;
  if (hasSlash(parentPathOrId)) {
    const path = parentPathOrId;
    const regexp = generateChildrenRegExp(path);
    queryBuilder = new PageQueryBuilder(this.find({ path: { $regex: regexp } }), true);
  }
  else {
    const parentId = parentPathOrId;
    queryBuilder = new PageQueryBuilder(this.find({ parent: parentId } as any), true); // TODO: improve type
  }
  await addViewerCondition(queryBuilder, user, userGroups);

  return queryBuilder
    .addConditionToSortPagesByAscPath()
    .query
    .lean()
    .exec();
};

schema.statics.findAncestorsChildrenByPathAndViewer = async function(path: string, user, userGroups = null): Promise<Record<string, PageDocument[]>> {
  const ancestorPaths = isTopPage(path) ? ['/'] : collectAncestorPaths(path); // root path is necessary for rendering
  const regexps = ancestorPaths.map(path => new RegExp(generateChildrenRegExp(path))); // cannot use re2

  // get pages at once
  const queryBuilder = new PageQueryBuilder(this.find({ path: { $in: regexps } }), true);
  await addViewerCondition(queryBuilder, user, userGroups);
  const _pages = await queryBuilder
    .addConditionAsMigrated()
    .addConditionToMinimizeDataForRendering()
    .addConditionToSortPagesByAscPath()
    .query
    .lean()
    .exec();
  // mark target
  const pages = _pages.map((page: PageDocument & {isTarget?: boolean}) => {
    if (page.path === path) {
      page.isTarget = true;
    }
    return page;
  });

  /*
   * If any non-migrated page is found during creating the pathToChildren map, it will stop incrementing at that moment
   */
  const pathToChildren: Record<string, PageDocument[]> = {};
  const sortedPaths = ancestorPaths.sort((a, b) => a.length - b.length); // sort paths by path.length
  sortedPaths.every((path) => {
    const children = pages.filter(page => nodePath.dirname(page.path) === path);
    if (children.length === 0) {
      return false; // break when children do not exist
    }
    pathToChildren[path] = children;
    return true;
  });

  return pathToChildren;
};

/*
 * Utils from obsolete-page.js
 */
async function pushRevision(pageData, newRevision, user) {
  await newRevision.save();

  pageData.revision = newRevision;
  pageData.lastUpdateUser = user;
  pageData.updatedAt = Date.now();

  return pageData.save();
}

/**
 * add/subtract descendantCount of pages with provided paths by increment.
 * increment can be negative number
 */
schema.statics.incrementDescendantCountOfPageIds = async function(pageIds: ObjectIdLike[], increment: number): Promise<void> {
  await this.updateMany({ _id: { $in: pageIds } }, { $inc: { descendantCount: increment } });
};

/**
 * recount descendantCount of a page with the provided id and return it
 */
schema.statics.recountDescendantCount = async function(id: ObjectIdLike):Promise<number> {
  const res = await this.aggregate(
    [
      {
        $match: {
          parent: id,
        },
      },
      {
        $project: {
          parent: 1,
          isEmpty: 1,
          descendantCount: 1,
        },
      },
      {
        $group: {
          _id: '$parent',
          sumOfDescendantCount: {
            $sum: '$descendantCount',
          },
          sumOfDocsCount: {
            $sum: {
              $cond: { if: { $eq: ['$isEmpty', true] }, then: 0, else: 1 }, // exclude isEmpty true page from sumOfDocsCount
            },
          },
        },
      },
      {
        $set: {
          descendantCount: {
            $sum: ['$sumOfDescendantCount', '$sumOfDocsCount'],
          },
        },
      },
    ],
  );

  return res.length === 0 ? 0 : res[0].descendantCount;
};

schema.statics.findAncestorsUsingParentRecursively = async function(pageId: ObjectIdLike, shouldIncludeTarget: boolean) {
  const self = this;
  const target = await this.findById(pageId);
  if (target == null) {
    throw Error('Target not found');
  }

  async function findAncestorsRecursively(target, ancestors = shouldIncludeTarget ? [target] : []) {
    const parent = await self.findOne({ _id: target.parent });
    if (parent == null) {
      return ancestors;
    }

    return findAncestorsRecursively(parent, [...ancestors, parent]);
  }

  return findAncestorsRecursively(target);
};

// TODO: write test code
/**
 * Recursively removes empty pages at leaf position.
 * @param pageId ObjectIdLike
 * @returns Promise<void>
 */
schema.statics.removeLeafEmptyPagesRecursively = async function(pageId: ObjectIdLike): Promise<void> {
  const self = this;

  const initialPage = await this.findById(pageId);

  if (initialPage == null) {
    return;
  }

  if (!initialPage.isEmpty) {
    return;
  }

  async function generatePageIdsToRemove(childPage, page, pageIds: ObjectIdLike[] = []): Promise<ObjectIdLike[]> {
    if (!page.isEmpty) {
      return pageIds;
    }

    const isChildrenOtherThanTargetExist = await self.exists({ _id: { $ne: childPage?._id }, parent: page._id });
    if (isChildrenOtherThanTargetExist) {
      return pageIds;
    }

    pageIds.push(page._id);

    const nextPage = await self.findById(page.parent);

    if (nextPage == null) {
      return pageIds;
    }

    return generatePageIdsToRemove(page, nextPage, pageIds);
  }

  const pageIdsToRemove = await generatePageIdsToRemove(null, initialPage);

  await this.deleteMany({ _id: { $in: pageIdsToRemove } });
};

schema.statics.normalizeDescendantCountById = async function(pageId) {
  const children = await this.find({ parent: pageId });

  const sumChildrenDescendantCount = children.map(d => d.descendantCount).reduce((c1, c2) => c1 + c2);
  const sumChildPages = children.filter(p => !p.isEmpty).length;

  return this.updateOne({ _id: pageId }, { $set: { descendantCount: sumChildrenDescendantCount + sumChildPages } }, { new: true });
};

schema.statics.takeOffFromTree = async function(pageId: ObjectIdLike) {
  return this.findByIdAndUpdate(pageId, { $set: { parent: null } });
};

schema.statics.removeEmptyPages = async function(pageIdsToNotRemove: ObjectIdLike[], paths: string[]): Promise<void> {
  await this.deleteMany({
    _id: {
      $nin: pageIdsToNotRemove,
    },
    path: {
      $in: paths,
    },
    isEmpty: true,
  });
};

schema.statics.PageQueryBuilder = PageQueryBuilder as any; // mongoose does not support constructor type as statics attrs type

export function generateGrantCondition(
    user, userGroups, showAnyoneKnowsLink = false, showPagesRestrictedByOwner = false, showPagesRestrictedByGroup = false,
): { $or: any[] } {
  const grantConditions: AnyObject[] = [
    { grant: null },
    { grant: GRANT_PUBLIC },
  ];

  if (showAnyoneKnowsLink) {
    grantConditions.push({ grant: GRANT_RESTRICTED });
  }

  if (showPagesRestrictedByOwner) {
    grantConditions.push(
      { grant: GRANT_SPECIFIED },
      { grant: GRANT_OWNER },
    );
  }
  else if (user != null) {
    grantConditions.push(
      { grant: GRANT_SPECIFIED, grantedUsers: user._id },
      { grant: GRANT_OWNER, grantedUsers: user._id },
    );
  }

  if (showPagesRestrictedByGroup) {
    grantConditions.push(
      { grant: GRANT_USER_GROUP },
    );
  }
  else if (userGroups != null && userGroups.length > 0) {
    grantConditions.push(
      { grant: GRANT_USER_GROUP, grantedGroup: { $in: userGroups } },
    );
  }

  return {
    $or: grantConditions,
  };
}

schema.statics.generateGrantCondition = generateGrantCondition;

export type PageCreateOptions = {
  format?: string
  grantUserGroupId?: ObjectIdLike
  grant?: number
}

/*
 * Merge obsolete page model methods and define new methods which depend on crowi instance
 */
export default (crowi: Crowi): any => {
  let pageEvent;
  if (crowi != null) {
    pageEvent = crowi.event('page');
  }

  schema.statics.create = async function(path: string, body: string, user, options: PageCreateOptions = {}) {
    if (crowi.pageGrantService == null || crowi.configManager == null || crowi.pageService == null || crowi.pageOperationService == null) {
      throw Error('Crowi is not setup');
    }

    const isV5Compatible = crowi.configManager.getConfig('crowi', 'app:isV5Compatible');
    // v4 compatible process
    if (!isV5Compatible) {
      return this.createV4(path, body, user, options);
    }

    const canOperate = await crowi.pageOperationService.canOperate(false, null, path);
    if (!canOperate) {
      throw Error(`Cannot operate create to path "${path}" right now.`);
    }

    const Page = this;
    const Revision = crowi.model('Revision');
    const {
      format = 'markdown', grantUserGroupId,
    } = options;
    let grant = options.grant;

    // sanitize path
    path = crowi.xss.process(path); // eslint-disable-line no-param-reassign
    // throw if exists
    const isExist = (await this.count({ path, isEmpty: false })) > 0; // not validate empty page
    if (isExist) {
      throw new Error('Cannot create new page to existed path');
    }
    // force public
    if (isTopPage(path)) {
      grant = GRANT_PUBLIC;
    }

    // find an existing empty page
    const emptyPage = await Page.findOne({ path, isEmpty: true });

    /*
     * UserGroup & Owner validation
     */
    if (grant !== GRANT_RESTRICTED) {
      let isGrantNormalized = false;
      try {
        // It must check descendants as well if emptyTarget is not null
        const shouldCheckDescendants = emptyPage != null;
        const newGrantedUserIds = grant === GRANT_OWNER ? [user._id] as IObjectId[] : undefined;

        isGrantNormalized = await crowi.pageGrantService.isGrantNormalized(user, path, grant, newGrantedUserIds, grantUserGroupId, shouldCheckDescendants);
      }
      catch (err) {
        logger.error(`Failed to validate grant of page at "${path}" of grant ${grant}:`, err);
        throw err;
      }
      if (!isGrantNormalized) {
        throw Error('The selected grant or grantedGroup is not assignable to this page.');
      }
    }

    /*
     * update empty page if exists, if not, create a new page
     */
    let page;
    if (emptyPage != null && grant !== GRANT_RESTRICTED) {
      page = emptyPage;
      const descendantCount = await this.recountDescendantCount(page._id);

      page.descendantCount = descendantCount;
      page.isEmpty = false;
    }
    else {
      page = new Page();
    }

    page.path = path;
    page.creator = user;
    page.lastUpdateUser = user;
    page.status = STATUS_PUBLISHED;

    // set parent to null when GRANT_RESTRICTED
    const isGrantRestricted = grant === GRANT_RESTRICTED;
    if (isTopPage(path) || isGrantRestricted) {
      page.parent = null;
    }
    else {
      const parent = await Page.getParentAndFillAncestors(path, user);
      page.parent = parent._id;
    }

    page.applyScope(user, grant, grantUserGroupId);

    let savedPage = await page.save();

    /*
     * After save
     */
    // Delete PageRedirect if exists
    const PageRedirect = mongoose.model('PageRedirect') as unknown as PageRedirectModel;
    try {
      await PageRedirect.deleteOne({ fromPath: path });
      logger.warn(`Deleted page redirect after creating a new page at path "${path}".`);
    }
    catch (err) {
      // no throw
      logger.error('Failed to delete PageRedirect');
    }

    const newRevision = Revision.prepareRevision(savedPage, body, null, user, { format });
    savedPage = await pushRevision(savedPage, newRevision, user);
    await savedPage.populateDataToShowRevision();

    pageEvent.emit('create', savedPage, user);

    // update descendantCount asynchronously
    await crowi.pageService.updateDescendantCountOfAncestors(savedPage._id, 1, false);

    return savedPage;
  };

  const shouldUseUpdatePageV4 = (grant:number, isV5Compatible:boolean, isOnTree:boolean): boolean => {
    const isRestricted = grant === GRANT_RESTRICTED;
    return !isRestricted && (!isV5Compatible || !isOnTree);
  };

  schema.statics.updatePage = async function(pageData, body, previousBody, user, options = {}) {
    if (crowi.configManager == null || crowi.pageGrantService == null || crowi.pageService == null) {
      throw Error('Crowi is not set up');
    }

    const wasOnTree = pageData.parent != null || isTopPage(pageData.path);
    const exParent = pageData.parent;
    const isV5Compatible = crowi.configManager.getConfig('crowi', 'app:isV5Compatible');

    const shouldUseV4Process = shouldUseUpdatePageV4(pageData.grant, isV5Compatible, wasOnTree);
    if (shouldUseV4Process) {
      // v4 compatible process
      return this.updatePageV4(pageData, body, previousBody, user, options);
    }

    const Revision = mongoose.model('Revision') as any; // TODO: Typescriptize model
    const grant = options.grant || pageData.grant; // use the previous data if absence
    const grantUserGroupId: undefined | ObjectIdLike = options.grantUserGroupId ?? pageData.grantedGroup?._id.toString();
    const isSyncRevisionToHackmd = options.isSyncRevisionToHackmd;
    const grantedUserIds = pageData.grantedUserIds || [user._id];
    const shouldBeOnTree = grant !== GRANT_RESTRICTED;
    const isChildrenExist = await this.count({ path: new RegExp(`^${escapeStringRegexp(addTrailingSlash(pageData.path))}`), parent: { $ne: null } });

    const newPageData = pageData;

    if (shouldBeOnTree) {
      let isGrantNormalized = false;
      try {
        isGrantNormalized = await crowi.pageGrantService.isGrantNormalized(user, pageData.path, grant, grantedUserIds, grantUserGroupId, true);
      }
      catch (err) {
        logger.error(`Failed to validate grant of page at "${pageData.path}" of grant ${grant}:`, err);
        throw err;
      }
      if (!isGrantNormalized) {
        throw Error('The selected grant or grantedGroup is not assignable to this page.');
      }

      if (!wasOnTree) {
        const newParent = await this.getParentAndFillAncestors(newPageData.path, user);
        newPageData.parent = newParent._id;
      }
    }
    else {
      if (wasOnTree && isChildrenExist) {
        // Update children's parent with new parent
        const newParentForChildren = await this.createEmptyPage(pageData.path, pageData.parent, user, pageData.descendantCount);
        await this.updateMany(
          { parent: pageData._id },
          { parent: newParentForChildren._id },
        );
      }

      newPageData.parent = null;
      newPageData.descendantCount = 0;
    }

    newPageData.applyScope(user, grant, grantUserGroupId);

    // update existing page
    let savedPage = await newPageData.save();
    const newRevision = await Revision.prepareRevision(newPageData, body, previousBody, user);
    savedPage = await pushRevision(savedPage, newRevision, user);
    await savedPage.populateDataToShowRevision();

    if (isSyncRevisionToHackmd) {
      savedPage = await this.syncRevisionToHackmd(savedPage);
    }

    pageEvent.emit('update', savedPage, user);

    // Update ex children's parent
    if (!wasOnTree && shouldBeOnTree) {
      const emptyPageAtSamePath = await this.findOne({ path: pageData.path, isEmpty: true }); // this page is necessary to find children

      if (isChildrenExist) {
        if (emptyPageAtSamePath != null) {
          // Update children's parent with new parent
          await this.updateMany(
            { parent: emptyPageAtSamePath._id },
            { parent: savedPage._id },
          );
        }
      }

      await this.findOneAndDelete({ path: pageData.path, isEmpty: true }); // delete here
    }

    // Sub operation
    // 1. Update descendantCount
    const shouldPlusDescCount = !wasOnTree && shouldBeOnTree;
    const shouldMinusDescCount = wasOnTree && !shouldBeOnTree;
    if (shouldPlusDescCount) {
      await crowi.pageService.updateDescendantCountOfAncestors(newPageData._id, 1, false);
      const newDescendantCount = await this.recountDescendantCount(newPageData._id);
      await this.updateOne({ _id: newPageData._id }, { descendantCount: newDescendantCount });
    }
    else if (shouldMinusDescCount) {
      // Update from parent. Parent is null if newPageData.grant is RESTRECTED.
      if (newPageData.grant === GRANT_RESTRICTED) {
        await crowi.pageService.updateDescendantCountOfAncestors(exParent, -1, true);
      }
    }

    // 2. Delete unnecessary empty pages

    const shouldRemoveLeafEmpPages = wasOnTree && !isChildrenExist;
    if (shouldRemoveLeafEmpPages) {
      await this.removeLeafEmptyPagesRecursively(exParent);
    }

    return savedPage;
  };

  // add old page schema methods
  const pageSchema = getPageSchema(crowi);
  schema.methods = { ...pageSchema.methods, ...schema.methods };
  schema.statics = { ...pageSchema.statics, ...schema.statics };

  return getOrCreateModel<PageDocument, PageModel>('Page', schema as any); // TODO: improve type
};
