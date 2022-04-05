import { pagePathUtils, pathUtils } from '@growi/core';
import mongoose, { ObjectId, QueryCursor } from 'mongoose';
import escapeStringRegexp from 'escape-string-regexp';
import streamToPromise from 'stream-to-promise';
import pathlib from 'path';
import { Readable, Writable } from 'stream';

import { createBatchStream } from '~/server/util/batch-stream';
import loggerFactory from '~/utils/logger';
import {
  CreateMethod, PageCreateOptions, PageModel, PageDocument,
} from '~/server/models/page';
import { stringifySnapshot } from '~/models/serializers/in-app-notification-snapshot/page';
import {
  IPage, IPageInfo, IPageInfoForEntity, IPageWithMeta,
} from '~/interfaces/page';
import { serializePageSecurely } from '../models/serializers/page-serializer';
import { PageRedirectModel } from '../models/page-redirect';
import Subscription from '../models/subscription';
import { ObjectIdLike } from '../interfaces/mongoose-utils';
import { IUserHasId } from '~/interfaces/user';
import { Ref } from '~/interfaces/common';
import { HasObjectId } from '~/interfaces/has-object-id';
import { SocketEventName, UpdateDescCountRawData } from '~/interfaces/websocket';
import {
  PageDeleteConfigValue, IPageDeleteConfigValueToProcessValidation,
} from '~/interfaces/page-delete-config';
import PageOperation, { PageActionStage, PageActionType } from '../models/page-operation';
import ActivityDefine from '../util/activityDefine';
import { prepareDeleteConfigValuesForCalc } from '~/utils/page-delete-config';

const debug = require('debug')('growi:services:page');

const logger = loggerFactory('growi:services:page');
const {
  isTrashPage, isTopPage, omitDuplicateAreaPageFromPages,
  collectAncestorPaths, isMovablePage, canMoveByPath,
} = pagePathUtils;

const { addTrailingSlash } = pathUtils;

const BULK_REINDEX_SIZE = 100;
const LIMIT_FOR_MULTIPLE_PAGE_OP = 20;

// TODO: improve type
class PageCursorsForDescendantsFactory {

  private user: any; // TODO: Typescriptize model

  private rootPage: any; // TODO: wait for mongoose update

  private shouldIncludeEmpty: boolean;

  private initialCursor: QueryCursor<any> | never[]; // TODO: wait for mongoose update

  private Page: PageModel;

  constructor(user: any, rootPage: any, shouldIncludeEmpty: boolean) {
    this.user = user;
    this.rootPage = rootPage;
    this.shouldIncludeEmpty = shouldIncludeEmpty;

    this.Page = mongoose.model('Page') as unknown as PageModel;
  }

  // prepare initial cursor
  private async init() {
    const initialCursor = await this.generateCursorToFindChildren(this.rootPage);
    this.initialCursor = initialCursor;
  }

  /**
   * Returns Iterable that yields only descendant pages unorderedly
   * @returns Promise<AsyncGenerator>
   */
  async generateIterable(): Promise<AsyncGenerator | never[]> {
    // initialize cursor
    await this.init();

    return this.isNeverArray(this.initialCursor) ? [] : this.generateOnlyDescendants(this.initialCursor);
  }

  /**
   * Returns Readable that produces only descendant pages unorderedly
   * @returns Promise<Readable>
   */
  async generateReadable(): Promise<Readable> {
    return Readable.from(await this.generateIterable());
  }

  /**
   * Generator that unorderedly yields descendant pages
   */
  private async* generateOnlyDescendants(cursor: QueryCursor<any>) {
    for await (const page of cursor) {
      const nextCursor = await this.generateCursorToFindChildren(page);
      if (!this.isNeverArray(nextCursor)) {
        yield* this.generateOnlyDescendants(nextCursor); // recursively yield
      }

      yield page;
    }
  }

  private async generateCursorToFindChildren(page: any): Promise<QueryCursor<any> | never[]> {
    if (page == null) {
      return [];
    }

    const { PageQueryBuilder } = this.Page;

    const builder = new PageQueryBuilder(this.Page.find(), this.shouldIncludeEmpty);
    builder.addConditionToFilteringByParentId(page._id);

    const cursor = builder.query.lean().cursor({ batchSize: BULK_REINDEX_SIZE }) as QueryCursor<any>;

    return cursor;
  }

  private isNeverArray(val: QueryCursor<any> | never[]): val is never[] {
    return 'length' in val && val.length === 0;
  }

}

class PageService {

  crowi: any;

  pageEvent: any;

  tagEvent: any;

  constructor(crowi) {
    this.crowi = crowi;
    this.pageEvent = crowi.event('page');
    this.tagEvent = crowi.event('tag');

    // init
    this.initPageEvent();
  }

  private initPageEvent() {
    // create
    this.pageEvent.on('create', this.pageEvent.onCreate);

    // createMany
    this.pageEvent.on('createMany', this.pageEvent.onCreateMany);
    this.pageEvent.on('addSeenUsers', this.pageEvent.onAddSeenUsers);

    // update
    this.pageEvent.on('update', async(page, user) => {

      this.pageEvent.onUpdate();

      try {
        await this.createAndSendNotifications(page, user, ActivityDefine.ACTION_PAGE_UPDATE);
      }
      catch (err) {
        logger.error(err);
      }
    });

    // rename
    this.pageEvent.on('rename', async(page, user) => {
      try {
        await this.createAndSendNotifications(page, user, ActivityDefine.ACTION_PAGE_RENAME);
      }
      catch (err) {
        logger.error(err);
      }
    });

    // delete
    this.pageEvent.on('delete', async(page, user) => {
      try {
        await this.createAndSendNotifications(page, user, ActivityDefine.ACTION_PAGE_DELETE);
      }
      catch (err) {
        logger.error(err);
      }
    });

    // delete completely
    this.pageEvent.on('deleteCompletely', async(page, user) => {
      try {
        await this.createAndSendNotifications(page, user, ActivityDefine.ACTION_PAGE_DELETE_COMPLETELY);
      }
      catch (err) {
        logger.error(err);
      }
    });

    // likes
    this.pageEvent.on('like', async(page, user) => {
      try {
        await this.createAndSendNotifications(page, user, ActivityDefine.ACTION_PAGE_LIKE);
      }
      catch (err) {
        logger.error(err);
      }
    });

    // bookmark
    this.pageEvent.on('bookmark', async(page, user) => {
      try {
        await this.createAndSendNotifications(page, user, ActivityDefine.ACTION_PAGE_BOOKMARK);
      }
      catch (err) {
        logger.error(err);
      }
    });
  }

  canDeleteCompletely(creatorId: ObjectIdLike, operator, isRecursively: boolean): boolean {
    const pageCompleteDeletionAuthority = this.crowi.configManager.getConfig('crowi', 'security:pageCompleteDeletionAuthority');
    const pageRecursiveCompleteDeletionAuthority = this.crowi.configManager.getConfig('crowi', 'security:pageRecursiveCompleteDeletionAuthority');

    const [singleAuthority, recursiveAuthority] = prepareDeleteConfigValuesForCalc(pageCompleteDeletionAuthority, pageRecursiveCompleteDeletionAuthority);

    return this.canDeleteLogic(creatorId, operator, isRecursively, singleAuthority, recursiveAuthority);
  }

  canDelete(creatorId: ObjectIdLike, operator, isRecursively: boolean): boolean {
    const pageDeletionAuthority = this.crowi.configManager.getConfig('crowi', 'security:pageDeletionAuthority');
    const pageRecursiveDeletionAuthority = this.crowi.configManager.getConfig('crowi', 'security:pageRecursiveDeletionAuthority');

    const [singleAuthority, recursiveAuthority] = prepareDeleteConfigValuesForCalc(pageDeletionAuthority, pageRecursiveDeletionAuthority);

    return this.canDeleteLogic(creatorId, operator, isRecursively, singleAuthority, recursiveAuthority);
  }

  private canDeleteLogic(
      creatorId: ObjectIdLike,
      operator,
      isRecursively: boolean,
      authority: IPageDeleteConfigValueToProcessValidation | null,
      recursiveAuthority: IPageDeleteConfigValueToProcessValidation | null,
  ): boolean {
    const isAdmin = operator.admin;
    const isOperator = operator?._id == null ? false : operator._id.equals(creatorId);

    if (isRecursively) {
      return this.compareDeleteConfig(isAdmin, isOperator, recursiveAuthority);
    }

    return this.compareDeleteConfig(isAdmin, isOperator, authority);
  }

  private compareDeleteConfig(isAdmin: boolean, isOperator: boolean, authority: IPageDeleteConfigValueToProcessValidation | null): boolean {
    if (isAdmin) {
      return true;
    }

    if (authority === PageDeleteConfigValue.Anyone || authority == null) {
      return true;
    }
    if (authority === PageDeleteConfigValue.AdminAndAuthor && isOperator) {
      return true;
    }

    return false;
  }

  filterPagesByCanDeleteCompletely(pages, user, isRecursively: boolean) {
    return pages.filter(p => p.isEmpty || this.canDeleteCompletely(p.creator, user, isRecursively));
  }

  filterPagesByCanDelete(pages, user, isRecursively: boolean) {
    return pages.filter(p => p.isEmpty || this.canDelete(p.creator, user, isRecursively));
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  async findPageAndMetaDataByViewer(pageId: string, path: string, user: IUserHasId, includeEmpty = false, isSharedPage = false): Promise<IPageWithMeta|null> {

    const Page = this.crowi.model('Page');

    let page: PageModel & PageDocument & HasObjectId;
    if (pageId != null) { // prioritized
      page = await Page.findByIdAndViewer(pageId, user, null, includeEmpty);
    }
    else {
      page = await Page.findByPathAndViewer(path, user, null, includeEmpty);
    }

    if (page == null) {
      return null;
    }

    if (isSharedPage) {
      return {
        data: page,
        meta: {
          isV5Compatible: isTopPage(page.path) || page.parent != null,
          isEmpty: page.isEmpty,
          isMovable: false,
          isDeletable: false,
          isAbleToDeleteCompletely: false,
          isRevertible: false,
        },
      };
    }

    const isGuestUser = user == null;
    const pageInfo = this.constructBasicPageInfo(page, isGuestUser);

    const Bookmark = this.crowi.model('Bookmark');
    const bookmarkCount = await Bookmark.countByPageId(pageId);

    const metadataForGuest = {
      ...pageInfo,
      bookmarkCount,
    };

    if (isGuestUser) {
      return {
        data: page,
        meta: metadataForGuest,
      };
    }

    const isBookmarked: boolean = (await Bookmark.findByPageIdAndUserId(pageId, user._id)) != null;
    const isLiked: boolean = page.isLiked(user);
    const isAbleToDeleteCompletely: boolean = this.canDeleteCompletely((page.creator as IUserHasId)?._id, user, false); // use normal delete config

    const subscription = await Subscription.findByUserIdAndTargetId(user._id, pageId);

    return {
      data: page,
      meta: {
        ...metadataForGuest,
        isAbleToDeleteCompletely,
        isBookmarked,
        isLiked,
        subscriptionStatus: subscription?.status,
      },
    };
  }

  private shouldUseV4Process(page): boolean {
    const Page = mongoose.model('Page') as unknown as PageModel;

    const isTrashPage = page.status === Page.STATUS_DELETED;
    const isPageMigrated = page.parent != null;
    const isV5Compatible = this.crowi.configManager.getConfig('crowi', 'app:isV5Compatible');
    const isRoot = isTopPage(page.path);
    const isPageRestricted = page.grant === Page.GRANT_RESTRICTED;

    const shouldUseV4Process = !isRoot && (!isV5Compatible || !isPageMigrated || isTrashPage || isPageRestricted);

    return shouldUseV4Process;
  }

  private shouldUseV4ProcessForRevert(page): boolean {
    const Page = mongoose.model('Page') as unknown as PageModel;

    const isV5Compatible = this.crowi.configManager.getConfig('crowi', 'app:isV5Compatible');
    const isPageRestricted = page.grant === Page.GRANT_RESTRICTED;

    const shouldUseV4Process = !isV5Compatible || isPageRestricted;

    return shouldUseV4Process;
  }

  private shouldNormalizeParent(page): boolean {
    const Page = mongoose.model('Page') as unknown as PageModel;

    return page.grant !== Page.GRANT_RESTRICTED && page.grant !== Page.GRANT_SPECIFIED;
  }

  /**
   * Generate read stream to operate descendants of the specified page path
   * @param {string} targetPagePath
   * @param {User} viewer
   */
  private async generateReadStreamToOperateOnlyDescendants(targetPagePath, userToOperate) {

    const Page = this.crowi.model('Page');
    const { PageQueryBuilder } = Page;

    const builder = new PageQueryBuilder(Page.find(), true)
      .addConditionAsNotMigrated() // to avoid affecting v5 pages
      .addConditionToListOnlyDescendants(targetPagePath);

    await Page.addConditionToFilteringByViewerToEdit(builder, userToOperate);
    return builder
      .query
      .lean()
      .cursor({ batchSize: BULK_REINDEX_SIZE });
  }

  async renamePage(page, newPagePath, user, options) {
    /*
     * Common Operation
     */
    const Page = mongoose.model('Page') as unknown as PageModel;

    const isExist = await Page.exists({ path: newPagePath });
    if (isExist) {
      throw Error(`Page already exists at ${newPagePath}`);
    }

    if (isTopPage(page.path)) {
      throw Error('It is forbidden to rename the top page');
    }

    // Separate v4 & v5 process
    const shouldUseV4Process = this.shouldUseV4Process(page);
    if (shouldUseV4Process) {
      return this.renamePageV4(page, newPagePath, user, options);
    }

    if (options.isMoveMode) {
      const fromPath = page.path;
      const toPath = newPagePath;
      const canMove = canMoveByPath(fromPath, toPath) && await Page.exists({ path: newPagePath });

      if (!canMove) {
        throw Error('Cannot move to this path.');
      }
    }

    const canOperate = await this.crowi.pageOperationService.canOperate(true, page.path, newPagePath);
    if (!canOperate) {
      throw Error(`Cannot operate rename to path "${newPagePath}" right now.`);
    }

    /*
     * Resumable Operation
     */
    let pageOp;
    try {
      pageOp = await PageOperation.create({
        actionType: PageActionType.Rename,
        actionStage: PageActionStage.Main,
        page,
        user,
        fromPath: page.path,
        toPath: newPagePath,
        options,
      });
    }
    catch (err) {
      logger.error('Failed to create PageOperation document.', err);
      throw err;
    }
    const renamedPage = await this.renameMainOperation(page, newPagePath, user, options, pageOp._id);

    return renamedPage;
  }

  async renameMainOperation(page, newPagePath: string, user, options, pageOpId: ObjectIdLike) {
    const Page = mongoose.model('Page') as unknown as PageModel;

    const updateMetadata = options.updateMetadata || false;
    // sanitize path
    newPagePath = this.crowi.xss.process(newPagePath); // eslint-disable-line no-param-reassign

    // UserGroup & Owner validation
    // use the parent's grant when target page is an empty page
    let grant;
    let grantedUserIds;
    let grantedGroupId;
    if (page.isEmpty) {
      const parent = await Page.findOne({ _id: page.parent });
      if (parent == null) {
        throw Error('parent not found');
      }
      grant = parent.grant;
      grantedUserIds = parent.grantedUsers;
      grantedGroupId = parent.grantedGroup;
    }
    else {
      grant = page.grant;
      grantedUserIds = page.grantedUsers;
      grantedGroupId = page.grantedGroup;
    }

    if (grant !== Page.GRANT_RESTRICTED) {
      let isGrantNormalized = false;
      try {
        isGrantNormalized = await this.crowi.pageGrantService.isGrantNormalized(user, newPagePath, grant, grantedUserIds, grantedGroupId, false);
      }
      catch (err) {
        logger.error(`Failed to validate grant of page at "${newPagePath}" when renaming`, err);
        throw err;
      }
      if (!isGrantNormalized) {
        throw Error(`This page cannot be renamed to "${newPagePath}" since the selected grant or grantedGroup is not assignable to this page.`);
      }
    }

    // 1. Take target off from tree
    await Page.takeOffFromTree(page._id);

    // 2. Find new parent
    let newParent;
    // If renaming to under target, run getParentAndforceCreateEmptyTree to fill new ancestors
    if (this.isRenamingToUnderTarget(page.path, newPagePath)) {
      newParent = await this.getParentAndforceCreateEmptyTree(page, newPagePath);
    }
    else {
      newParent = await Page.getParentAndFillAncestors(newPagePath, user);
    }

    // 3. Put back target page to tree (also update the other attrs)
    const update: Partial<IPage> = {};
    update.path = newPagePath;
    update.parent = newParent._id;
    if (updateMetadata) {
      update.lastUpdateUser = user;
      update.updatedAt = new Date();
    }
    const renamedPage = await Page.findByIdAndUpdate(page._id, { $set: update }, { new: true });

    // create page redirect
    if (options.createRedirectPage) {
      const PageRedirect = mongoose.model('PageRedirect') as unknown as PageRedirectModel;
      await PageRedirect.create({ fromPath: page.path, toPath: newPagePath });
    }
    this.pageEvent.emit('rename', page, user);

    // Set to Sub
    const pageOp = await PageOperation.findByIdAndUpdatePageActionStage(pageOpId, PageActionStage.Sub);
    if (pageOp == null) {
      throw Error('PageOperation document not found');
    }

    /*
     * Sub Operation
     */
    this.renameSubOperation(page, newPagePath, user, options, renamedPage, pageOp._id);

    return renamedPage;
  }

  async renameSubOperation(page, newPagePath: string, user, options, renamedPage, pageOpId: ObjectIdLike): Promise<void> {
    const Page = mongoose.model('Page') as unknown as PageModel;

    const exParentId = page.parent;

    // update descendants first
    await this.renameDescendantsWithStream(page, newPagePath, user, options, false);

    // reduce ancestore's descendantCount
    const nToReduce = -1 * ((page.isEmpty ? 0 : 1) + page.descendantCount);
    await this.updateDescendantCountOfAncestors(exParentId, nToReduce, true);

    // increase ancestore's descendantCount
    const nToIncrease = (renamedPage.isEmpty ? 0 : 1) + page.descendantCount;
    await this.updateDescendantCountOfAncestors(renamedPage._id, nToIncrease, false);

    // Remove leaf empty pages if not moving to under the ex-target position
    if (!this.isRenamingToUnderTarget(page.path, newPagePath)) {
      // remove empty pages at leaf position
      await Page.removeLeafEmptyPagesRecursively(page.parent);
    }

    await PageOperation.findByIdAndDelete(pageOpId);
  }

  private isRenamingToUnderTarget(fromPath: string, toPath: string): boolean {
    const pathToTest = escapeStringRegexp(addTrailingSlash(fromPath));
    const pathToBeTested = toPath;

    return (new RegExp(`^${pathToTest}`, 'i')).test(pathToBeTested);
  }

  private async getParentAndforceCreateEmptyTree(originalPage, toPath: string) {
    const Page = mongoose.model('Page') as unknown as PageModel;

    const fromPath = originalPage.path;
    const newParentPath = pathlib.dirname(toPath);

    // local util
    const collectAncestorPathsUntilFromPath = (path: string, paths: string[] = []): string[] => {
      if (path === fromPath) return paths;

      const parentPath = pathlib.dirname(path);
      paths.push(parentPath);
      return collectAncestorPathsUntilFromPath(parentPath, paths);
    };

    const pathsToInsert = collectAncestorPathsUntilFromPath(toPath);
    const originalParent = await Page.findById(originalPage.parent);
    if (originalParent == null) {
      throw Error('Original parent not found');
    }
    const insertedPages = await Page.insertMany(pathsToInsert.map((path) => {
      return {
        path,
        isEmpty: true,
      };
    }));

    const pages = [...insertedPages, originalParent];

    const ancestorsMap = new Map<string, PageDocument & {_id: any}>(pages.map(p => [p.path, p]));

    // bulkWrite to update ancestors
    const operations = insertedPages.map((page) => {
      const parentPath = pathlib.dirname(page.path);
      const op = {
        updateOne: {
          filter: {
            _id: page._id,
          },
          update: {
            $set: {
              parent: ancestorsMap.get(parentPath)?._id,
              descedantCount: originalParent.descendantCount,
            },
          },
        },
      };

      return op;
    });
    await Page.bulkWrite(operations);

    const newParent = ancestorsMap.get(newParentPath);
    return newParent;
  }

  private async renamePageV4(page, newPagePath, user, options) {
    const Page = this.crowi.model('Page');
    const Revision = this.crowi.model('Revision');
    const {
      isRecursively = false,
      createRedirectPage = false,
      updateMetadata = false,
    } = options;

    // sanitize path
    newPagePath = this.crowi.xss.process(newPagePath); // eslint-disable-line no-param-reassign

    // create descendants first
    if (isRecursively) {
      await this.renameDescendantsWithStream(page, newPagePath, user, options);
    }


    const update: any = {};
    // update Page
    update.path = newPagePath;
    if (updateMetadata) {
      update.lastUpdateUser = user;
      update.updatedAt = Date.now();
    }
    const renamedPage = await Page.findByIdAndUpdate(page._id, { $set: update }, { new: true });

    // update Rivisions
    await Revision.updateRevisionListByPageId(renamedPage._id, { pageId: renamedPage._id });

    if (createRedirectPage) {
      const PageRedirect = mongoose.model('PageRedirect') as unknown as PageRedirectModel;
      await PageRedirect.create({ fromPath: page.path, toPath: newPagePath });
    }

    this.pageEvent.emit('rename', page, user);

    return renamedPage;
  }

  private async renameDescendants(pages, user, options, oldPagePathPrefix, newPagePathPrefix, shouldUseV4Process = true) {
    // v4 compatible process
    if (shouldUseV4Process) {
      return this.renameDescendantsV4(pages, user, options, oldPagePathPrefix, newPagePathPrefix);
    }

    const Page = mongoose.model('Page') as unknown as PageModel;
    const PageRedirect = mongoose.model('PageRedirect') as unknown as PageRedirectModel;

    const { updateMetadata, createRedirectPage } = options;

    const updatePathOperations: any[] = [];
    const insertPageRedirectOperations: any[] = [];

    pages.forEach((page) => {
      const newPagePath = page.path.replace(oldPagePathPrefix, newPagePathPrefix);

      // increment updatePathOperations
      let update;
      if (!page.isEmpty && updateMetadata) {
        update = {
          $set: { path: newPagePath, lastUpdateUser: user._id, updatedAt: new Date() },
        };

      }
      else {
        update = {
          $set: { path: newPagePath },
        };
      }

      if (!page.isEmpty && createRedirectPage) {
        // insert PageRedirect
        insertPageRedirectOperations.push({
          insertOne: {
            document: {
              fromPath: page.path,
              toPath: newPagePath,
            },
          },
        });
      }

      updatePathOperations.push({
        updateOne: {
          filter: {
            _id: page._id,
          },
          update,
        },
      });
    });

    try {
      await Page.bulkWrite(updatePathOperations);
    }
    catch (err) {
      if (err.code !== 11000) {
        throw new Error(`Failed to rename pages: ${err}`);
      }
    }

    try {
      await PageRedirect.bulkWrite(insertPageRedirectOperations);
    }
    catch (err) {
      if (err.code !== 11000) {
        throw Error(`Failed to create PageRedirect documents: ${err}`);
      }
    }

    this.pageEvent.emit('updateMany', pages, user);
  }

  private async renameDescendantsV4(pages, user, options, oldPagePathPrefix, newPagePathPrefix) {
    const PageRedirect = mongoose.model('PageRedirect') as unknown as PageRedirectModel;
    const pageCollection = mongoose.connection.collection('pages');
    const { updateMetadata, createRedirectPage } = options;

    const unorderedBulkOp = pageCollection.initializeUnorderedBulkOp();
    const insertPageRedirectOperations: any[] = [];

    pages.forEach((page) => {
      const newPagePath = page.path.replace(oldPagePathPrefix, newPagePathPrefix);

      if (updateMetadata) {
        unorderedBulkOp
          .find({ _id: page._id })
          .update({ $set: { path: newPagePath, lastUpdateUser: user._id, updatedAt: new Date() } });
      }
      else {
        unorderedBulkOp.find({ _id: page._id }).update({ $set: { path: newPagePath } });
      }
      // insert PageRedirect
      if (!page.isEmpty && createRedirectPage) {
        insertPageRedirectOperations.push({
          insertOne: {
            document: {
              fromPath: page.path,
              toPath: newPagePath,
            },
          },
        });
      }
    });

    try {
      await unorderedBulkOp.execute();
    }
    catch (err) {
      if (err.code !== 11000) {
        throw new Error(`Failed to rename pages: ${err}`);
      }
    }

    try {
      await PageRedirect.bulkWrite(insertPageRedirectOperations);
    }
    catch (err) {
      if (err.code !== 11000) {
        throw Error(`Failed to create PageRedirect documents: ${err}`);
      }
    }

    this.pageEvent.emit('updateMany', pages, user);
  }

  private async renameDescendantsWithStream(targetPage, newPagePath, user, options = {}, shouldUseV4Process = true) {
    // v4 compatible process
    if (shouldUseV4Process) {
      return this.renameDescendantsWithStreamV4(targetPage, newPagePath, user, options);
    }

    const factory = new PageCursorsForDescendantsFactory(user, targetPage, true);
    const readStream = await factory.generateReadable();

    const newPagePathPrefix = newPagePath;
    const pathRegExp = new RegExp(`^${escapeStringRegexp(targetPage.path)}`, 'i');

    const renameDescendants = this.renameDescendants.bind(this);
    const pageEvent = this.pageEvent;
    let count = 0;
    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        try {
          count += batch.length;
          await renameDescendants(
            batch, user, options, pathRegExp, newPagePathPrefix, shouldUseV4Process,
          );
          logger.debug(`Renaming pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('Renaming error on add anyway: ', err);
        }

        callback();
      },
      async final(callback) {
        logger.debug(`Renaming pages has completed: (totalCount=${count})`);

        // update path
        targetPage.path = newPagePath;
        pageEvent.emit('syncDescendantsUpdate', targetPage, user);

        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);

    await streamToPromise(writeStream);
  }

  private async renameDescendantsWithStreamV4(targetPage, newPagePath, user, options = {}) {

    const readStream = await this.generateReadStreamToOperateOnlyDescendants(targetPage.path, user);

    const newPagePathPrefix = newPagePath;
    const pathRegExp = new RegExp(`^${escapeStringRegexp(targetPage.path)}`, 'i');

    const renameDescendants = this.renameDescendants.bind(this);
    const pageEvent = this.pageEvent;
    let count = 0;
    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        try {
          count += batch.length;
          await renameDescendants(batch, user, options, pathRegExp, newPagePathPrefix);
          logger.debug(`Renaming pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('renameDescendants error on add anyway: ', err);
        }

        callback();
      },
      final(callback) {
        logger.debug(`Renaming pages has completed: (totalCount=${count})`);
        // update  path
        targetPage.path = newPagePath;
        pageEvent.emit('syncDescendantsUpdate', targetPage, user);
        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);

    await streamToPromise(writeStream);
  }

  /*
   * Duplicate
   */
  async duplicate(page, newPagePath, user, isRecursively) {
    /*
     * Common Operation
     */
    const isEmptyAndNotRecursively = page?.isEmpty && !isRecursively;
    if (page == null || isEmptyAndNotRecursively) {
      throw new Error('Cannot find or duplicate the empty page');
    }

    const Page = mongoose.model('Page') as unknown as PageModel;
    const PageTagRelation = mongoose.model('PageTagRelation') as any; // TODO: Typescriptize model

    if (!isRecursively && page.isEmpty) {
      throw Error('Page not found.');
    }

    newPagePath = this.crowi.xss.process(newPagePath); // eslint-disable-line no-param-reassign

    // 1. Separate v4 & v5 process
    const shouldUseV4Process = this.shouldUseV4Process(page);
    if (shouldUseV4Process) {
      return this.duplicateV4(page, newPagePath, user, isRecursively);
    }

    const canOperate = await this.crowi.pageOperationService.canOperate(isRecursively, page.path, newPagePath);
    if (!canOperate) {
      throw Error(`Cannot operate duplicate to path "${newPagePath}" right now.`);
    }

    // 2. UserGroup & Owner validation
    // use the parent's grant when target page is an empty page
    let grant;
    let grantedUserIds;
    let grantedGroupId;
    if (page.isEmpty) {
      const parent = await Page.findOne({ _id: page.parent });
      if (parent == null) {
        throw Error('parent not found');
      }
      grant = parent.grant;
      grantedUserIds = parent.grantedUsers;
      grantedGroupId = parent.grantedGroup;
    }
    else {
      grant = page.grant;
      grantedUserIds = page.grantedUsers;
      grantedGroupId = page.grantedGroup;
    }

    if (grant !== Page.GRANT_RESTRICTED) {
      let isGrantNormalized = false;
      try {
        isGrantNormalized = await this.crowi.pageGrantService.isGrantNormalized(user, newPagePath, grant, grantedUserIds, grantedGroupId, false);
      }
      catch (err) {
        logger.error(`Failed to validate grant of page at "${newPagePath}" when duplicating`, err);
        throw err;
      }
      if (!isGrantNormalized) {
        throw Error(`This page cannot be duplicated to "${newPagePath}" since the selected grant or grantedGroup is not assignable to this page.`);
      }
    }

    // copy & populate (reason why copy: SubOperation only allows non-populated page document)
    const copyPage = { ...page };

    // 3. Duplicate target
    const options: PageCreateOptions = {
      grant: page.grant,
      grantUserGroupId: page.grantedGroup,
    };
    let duplicatedTarget;
    if (page.isEmpty) {
      const parent = await Page.getParentAndFillAncestors(newPagePath, user);
      duplicatedTarget = await Page.createEmptyPage(newPagePath, parent);
    }
    else {
      await page.populate({ path: 'revision', model: 'Revision', select: 'body' });
      duplicatedTarget = await (Page.create as CreateMethod)(
        newPagePath, page.revision.body, user, options,
      );
    }

    // 4. Take over tags
    const originTags = await page.findRelatedTagsById();
    let savedTags = [];
    if (originTags.length !== 0) {
      await PageTagRelation.updatePageTags(duplicatedTarget._id, originTags);
      savedTags = await PageTagRelation.listTagNamesByPage(duplicatedTarget._id);
      this.tagEvent.emit('update', duplicatedTarget, savedTags);
    }

    if (isRecursively) {
      /*
       * Resumable Operation
       */
      let pageOp;
      try {
        pageOp = await PageOperation.create({
          actionType: PageActionType.Duplicate,
          actionStage: PageActionStage.Main,
          page: copyPage,
          user,
          fromPath: page.path,
          toPath: newPagePath,
        });
      }
      catch (err) {
        logger.error('Failed to create PageOperation document.', err);
        throw err;
      }
      this.duplicateRecursivelyMainOperation(page, newPagePath, user, pageOp._id);
    }

    const result = serializePageSecurely(duplicatedTarget);
    result.tags = savedTags;
    return result;
  }

  async duplicateRecursivelyMainOperation(page, newPagePath: string, user, pageOpId: ObjectIdLike): Promise<void> {
    const nDuplicatedPages = await this.duplicateDescendantsWithStream(page, newPagePath, user, false);

    // normalize parent of descendant pages
    const shouldNormalize = this.shouldNormalizeParent(page);
    if (shouldNormalize) {
      try {
        await this.normalizeParentAndDescendantCountOfDescendants(newPagePath, user);
        logger.info(`Successfully normalized duplicated descendant pages under "${newPagePath}"`);
      }
      catch (err) {
        logger.error('Failed to normalize descendants afrer duplicate:', err);
        throw err;
      }
    }

    // Set to Sub
    const pageOp = await PageOperation.findByIdAndUpdatePageActionStage(pageOpId, PageActionStage.Sub);
    if (pageOp == null) {
      throw Error('PageOperation document not found');
    }

    /*
     * Sub Operation
     */
    await this.duplicateRecursivelySubOperation(newPagePath, nDuplicatedPages, pageOp._id);
  }

  async duplicateRecursivelySubOperation(newPagePath: string, nDuplicatedPages: number, pageOpId: ObjectIdLike): Promise<void> {
    const Page = mongoose.model('Page');
    const newTarget = await Page.findOne({ path: newPagePath }); // only one page will be found since duplicating to existing path is forbidden
    if (newTarget == null) {
      throw Error('No duplicated page found. Something might have gone wrong in duplicateRecursivelyMainOperation.');
    }

    await this.updateDescendantCountOfAncestors(newTarget._id, nDuplicatedPages, false);

    await PageOperation.findByIdAndDelete(pageOpId);
  }

  async duplicateV4(page, newPagePath, user, isRecursively) {
    const Page = this.crowi.model('Page');
    const PageTagRelation = mongoose.model('PageTagRelation') as any; // TODO: Typescriptize model
    // populate
    await page.populate({ path: 'revision', model: 'Revision', select: 'body' });

    // create option
    const options: any = { page };
    options.grant = page.grant;
    options.grantUserGroupId = page.grantedGroup;
    options.grantedUserIds = page.grantedUsers;

    newPagePath = this.crowi.xss.process(newPagePath); // eslint-disable-line no-param-reassign

    const createdPage = await Page.create(
      newPagePath, page.revision.body, user, options,
    );

    if (isRecursively) {
      this.duplicateDescendantsWithStream(page, newPagePath, user);
    }

    // take over tags
    const originTags = await page.findRelatedTagsById();
    let savedTags = [];
    if (originTags != null) {
      await PageTagRelation.updatePageTags(createdPage.id, originTags);
      savedTags = await PageTagRelation.listTagNamesByPage(createdPage.id);
      this.tagEvent.emit('update', createdPage, savedTags);
    }
    const result = serializePageSecurely(createdPage);
    result.tags = savedTags;

    return result;
  }

  /**
   * Receive the object with oldPageId and newPageId and duplicate the tags from oldPage to newPage
   * @param {Object} pageIdMapping e.g. key: oldPageId, value: newPageId
   */
  private async duplicateTags(pageIdMapping) {
    const PageTagRelation = mongoose.model('PageTagRelation');

    // convert pageId from string to ObjectId
    const pageIds = Object.keys(pageIdMapping);
    const stage = { $or: pageIds.map((pageId) => { return { relatedPage: new mongoose.Types.ObjectId(pageId) } }) };

    const pagesAssociatedWithTag = await PageTagRelation.aggregate([
      {
        $match: stage,
      },
      {
        $group: {
          _id: '$relatedTag',
          relatedPages: { $push: '$relatedPage' },
        },
      },
    ]);

    const newPageTagRelation: any[] = [];
    pagesAssociatedWithTag.forEach(({ _id, relatedPages }) => {
      // relatedPages
      relatedPages.forEach((pageId) => {
        newPageTagRelation.push({
          relatedPage: pageIdMapping[pageId], // newPageId
          relatedTag: _id,
        });
      });
    });

    return PageTagRelation.insertMany(newPageTagRelation, { ordered: false });
  }

  private async duplicateDescendants(pages, user, oldPagePathPrefix, newPagePathPrefix, shouldUseV4Process = true) {
    if (shouldUseV4Process) {
      return this.duplicateDescendantsV4(pages, user, oldPagePathPrefix, newPagePathPrefix);
    }

    const Page = this.crowi.model('Page');
    const Revision = this.crowi.model('Revision');

    const pageIds = pages.map(page => page._id);
    const revisions = await Revision.find({ pageId: { $in: pageIds } });

    // Mapping to set to the body of the new revision
    const pageIdRevisionMapping = {};
    revisions.forEach((revision) => {
      pageIdRevisionMapping[revision.pageId] = revision;
    });

    // key: oldPageId, value: newPageId
    const pageIdMapping = {};
    const newPages: any[] = [];
    const newRevisions: any[] = [];

    // no need to save parent here
    pages.forEach((page) => {
      const newPageId = new mongoose.Types.ObjectId();
      const newPagePath = page.path.replace(oldPagePathPrefix, newPagePathPrefix);
      const revisionId = new mongoose.Types.ObjectId();
      pageIdMapping[page._id] = newPageId;

      let newPage;
      if (!page.isEmpty) {
        newPage = {
          _id: newPageId,
          path: newPagePath,
          creator: user._id,
          grant: page.grant,
          grantedGroup: page.grantedGroup,
          grantedUsers: page.grantedUsers,
          lastUpdateUser: user._id,
          revision: revisionId,
        };
        newRevisions.push({
          _id: revisionId, pageId: newPageId, body: pageIdRevisionMapping[page._id].body, author: user._id, format: 'markdown',
        });
      }
      newPages.push(newPage);
    });

    await Page.insertMany(newPages, { ordered: false });
    await Revision.insertMany(newRevisions, { ordered: false });
    await this.duplicateTags(pageIdMapping);
  }

  private async duplicateDescendantsV4(pages, user, oldPagePathPrefix, newPagePathPrefix) {
    const Page = this.crowi.model('Page');
    const Revision = this.crowi.model('Revision');

    const pageIds = pages.map(page => page._id);
    const revisions = await Revision.find({ pageId: { $in: pageIds } });

    // Mapping to set to the body of the new revision
    const pageIdRevisionMapping = {};
    revisions.forEach((revision) => {
      pageIdRevisionMapping[revision.pageId] = revision;
    });

    // key: oldPageId, value: newPageId
    const pageIdMapping = {};
    const newPages: any[] = [];
    const newRevisions: any[] = [];

    pages.forEach((page) => {
      const newPageId = new mongoose.Types.ObjectId();
      const newPagePath = page.path.replace(oldPagePathPrefix, newPagePathPrefix);
      const revisionId = new mongoose.Types.ObjectId();
      pageIdMapping[page._id] = newPageId;

      newPages.push({
        _id: newPageId,
        path: newPagePath,
        creator: user._id,
        grant: page.grant,
        grantedGroup: page.grantedGroup,
        grantedUsers: page.grantedUsers,
        lastUpdateUser: user._id,
        revision: revisionId,
      });

      newRevisions.push({
        _id: revisionId, pageId: newPageId, body: pageIdRevisionMapping[page._id].body, author: user._id, format: 'markdown',
      });

    });

    await Page.insertMany(newPages, { ordered: false });
    await Revision.insertMany(newRevisions, { ordered: false });
    await this.duplicateTags(pageIdMapping);
  }

  private async duplicateDescendantsWithStream(page, newPagePath, user, shouldUseV4Process = true) {
    if (shouldUseV4Process) {
      return this.duplicateDescendantsWithStreamV4(page, newPagePath, user);
    }

    const iterableFactory = new PageCursorsForDescendantsFactory(user, page, true);
    const readStream = await iterableFactory.generateReadable();

    const newPagePathPrefix = newPagePath;
    const pathRegExp = new RegExp(`^${escapeStringRegexp(page.path)}`, 'i');

    const duplicateDescendants = this.duplicateDescendants.bind(this);
    const pageEvent = this.pageEvent;
    let count = 0;
    let nNonEmptyDuplicatedPages = 0;
    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        try {
          count += batch.length;
          nNonEmptyDuplicatedPages += batch.filter(page => !page.isEmpty).length;
          await duplicateDescendants(batch, user, pathRegExp, newPagePathPrefix, shouldUseV4Process);
          logger.debug(`Adding pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('addAllPages error on add anyway: ', err);
        }

        callback();
      },
      async final(callback) {
        logger.debug(`Adding pages has completed: (totalCount=${count})`);
        // update  path
        page.path = newPagePath;
        pageEvent.emit('syncDescendantsUpdate', page, user);
        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);

    await streamToPromise(writeStream);

    return nNonEmptyDuplicatedPages;
  }

  private async duplicateDescendantsWithStreamV4(page, newPagePath, user) {
    const readStream = await this.generateReadStreamToOperateOnlyDescendants(page.path, user);

    const newPagePathPrefix = newPagePath;
    const pathRegExp = new RegExp(`^${escapeStringRegexp(page.path)}`, 'i');

    const duplicateDescendants = this.duplicateDescendants.bind(this);
    const pageEvent = this.pageEvent;
    let count = 0;
    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        try {
          count += batch.length;
          await duplicateDescendants(batch, user, pathRegExp, newPagePathPrefix);
          logger.debug(`Adding pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('addAllPages error on add anyway: ', err);
        }

        callback();
      },
      final(callback) {
        logger.debug(`Adding pages has completed: (totalCount=${count})`);
        // update  path
        page.path = newPagePath;
        pageEvent.emit('syncDescendantsUpdate', page, user);
        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);

    await streamToPromise(writeStream);

    return count;
  }

  /*
   * Delete
   */
  async deletePage(page, user, options = {}, isRecursively = false) {
    /*
     * Common Operation
     */
    const Page = mongoose.model('Page') as PageModel;

    // Separate v4 & v5 process
    const shouldUseV4Process = this.shouldUseV4Process(page);
    if (shouldUseV4Process) {
      return this.deletePageV4(page, user, options, isRecursively);
    }
    // Validate
    if (page.isEmpty && !isRecursively) {
      throw Error('Page not found.');
    }
    const isTrashed = isTrashPage(page.path);
    if (isTrashed) {
      throw new Error('This method does NOT support deleting trashed pages.');
    }

    if (!isMovablePage(page.path)) {
      throw new Error('Page is not deletable.');
    }

    const newPath = Page.getDeletedPageName(page.path);

    const canOperate = await this.crowi.pageOperationService.canOperate(isRecursively, page.path, newPath);
    if (!canOperate) {
      throw Error(`Cannot operate delete to path "${newPath}" right now.`);
    }

    // Replace with an empty page
    const isChildrenExist = await Page.exists({ parent: page._id });
    const shouldReplace = !isRecursively && isChildrenExist;
    if (shouldReplace) {
      await Page.replaceTargetWithPage(page, null, true);
    }

    // Delete target (only updating an existing document's properties )
    let deletedPage;
    if (!page.isEmpty) {
      deletedPage = await this.deleteNonEmptyTarget(page, user);
    }
    else { // always recursive
      deletedPage = page;
      await this.deleteEmptyTarget(page);
    }

    // 1. Update descendantCount
    if (isRecursively) {
      const inc = page.isEmpty ? -page.descendantCount : -(page.descendantCount + 1);
      await this.updateDescendantCountOfAncestors(page.parent, inc, true);
    }
    else {
      // update descendantCount of ancestors'
      await this.updateDescendantCountOfAncestors(page.parent, -1, true);
    }
    // 2. Delete leaf empty pages
    await Page.removeLeafEmptyPagesRecursively(page.parent);

    if (isRecursively) {
      let pageOp;
      try {
        pageOp = await PageOperation.create({
          actionType: PageActionType.Delete,
          actionStage: PageActionStage.Main,
          page,
          user,
          fromPath: page.path,
          toPath: newPath,
        });
      }
      catch (err) {
        logger.error('Failed to create PageOperation document.', err);
        throw err;
      }
      /*
       * Resumable Operation
       */
      this.deleteRecursivelyMainOperation(page, user, pageOp._id);
    }

    return deletedPage;
  }

  private async deleteNonEmptyTarget(page, user) {
    const Page = mongoose.model('Page') as unknown as PageModel;
    const PageTagRelation = mongoose.model('PageTagRelation') as any; // TODO: Typescriptize model
    const PageRedirect = mongoose.model('PageRedirect') as unknown as PageRedirectModel;
    const newPath = Page.getDeletedPageName(page.path);

    const deletedPage = await Page.findByIdAndUpdate(page._id, {
      $set: {
        path: newPath, status: Page.STATUS_DELETED, deleteUser: user._id, deletedAt: Date.now(), parent: null, descendantCount: 0, // set parent as null
      },
    }, { new: true });

    await PageTagRelation.updateMany({ relatedPage: page._id }, { $set: { isPageTrashed: true } });
    try {
      await PageRedirect.create({ fromPath: page.path, toPath: newPath });
    }
    catch (err) {
      if (err.code !== 11000) {
        throw err;
      }
    }
    this.pageEvent.emit('delete', page, user);
    this.pageEvent.emit('create', deletedPage, user);

    return deletedPage;
  }

  private async deleteEmptyTarget(page): Promise<void> {
    const Page = mongoose.model('Page') as unknown as PageModel;

    await Page.deleteOne({ _id: page._id, isEmpty: true });
  }

  async deleteRecursivelyMainOperation(page, user, pageOpId: ObjectIdLike): Promise<void> {
    await this.deleteDescendantsWithStream(page, user, false);

    await PageOperation.findByIdAndDelete(pageOpId);

    // no sub operation available
  }

  private async deletePageV4(page, user, options = {}, isRecursively = false) {
    const Page = mongoose.model('Page') as PageModel;
    const PageTagRelation = mongoose.model('PageTagRelation') as any; // TODO: Typescriptize model
    const Revision = mongoose.model('Revision') as any; // TODO: Typescriptize model
    const PageRedirect = mongoose.model('PageRedirect') as unknown as PageRedirectModel;

    const newPath = Page.getDeletedPageName(page.path);
    const isTrashed = isTrashPage(page.path);

    if (isTrashed) {
      throw new Error('This method does NOT support deleting trashed pages.');
    }

    if (!isMovablePage(page.path)) {
      throw new Error('Page is not deletable.');
    }

    if (isRecursively) {
      this.deleteDescendantsWithStream(page, user);
    }

    // update Revisions
    await Revision.updateRevisionListByPageId(page._id, { pageId: page._id });
    const deletedPage = await Page.findByIdAndUpdate(page._id, {
      $set: {
        path: newPath, status: Page.STATUS_DELETED, deleteUser: user._id, deletedAt: Date.now(),
      },
    }, { new: true });
    await PageTagRelation.updateMany({ relatedPage: page._id }, { $set: { isPageTrashed: true } });

    try {
      await PageRedirect.create({ fromPath: page.path, toPath: newPath });
    }
    catch (err) {
      if (err.code !== 11000) {
        throw err;
      }
    }

    this.pageEvent.emit('delete', page, user);
    this.pageEvent.emit('create', deletedPage, user);

    return deletedPage;
  }

  private async deleteDescendants(pages, user) {
    const Page = mongoose.model('Page') as unknown as PageModel;
    const PageRedirect = mongoose.model('PageRedirect') as unknown as PageRedirectModel;

    const deletePageOperations: any[] = [];
    const insertPageRedirectOperations: any[] = [];

    pages.forEach((page) => {
      const newPath = Page.getDeletedPageName(page.path);

      let operation;
      // if empty, delete completely
      if (page.isEmpty) {
        operation = {
          deleteOne: {
            filter: { _id: page._id },
          },
        };
      }
      // if not empty, set parent to null and update to trash
      else {
        operation = {
          updateOne: {
            filter: { _id: page._id },
            update: {
              $set: {
                path: newPath, status: Page.STATUS_DELETED, deleteUser: user._id, deletedAt: Date.now(), parent: null, descendantCount: 0, // set parent as null
              },
            },
          },
        };

        insertPageRedirectOperations.push({
          insertOne: {
            document: {
              fromPath: page.path,
              toPath: newPath,
            },
          },
        });
      }

      deletePageOperations.push(operation);
    });

    try {
      await Page.bulkWrite(deletePageOperations);
    }
    catch (err) {
      if (err.code !== 11000) {
        throw new Error(`Failed to delete pages: ${err}`);
      }
    }
    finally {
      this.pageEvent.emit('syncDescendantsDelete', pages, user);
    }

    try {
      await PageRedirect.bulkWrite(insertPageRedirectOperations);
    }
    catch (err) {
      if (err.code !== 11000) {
        throw Error(`Failed to create PageRedirect documents: ${err}`);
      }
    }
  }

  /**
   * Create delete stream and return deleted document count
   */
  private async deleteDescendantsWithStream(targetPage, user, shouldUseV4Process = true): Promise<number> {
    let readStream;
    if (shouldUseV4Process) {
      readStream = await this.generateReadStreamToOperateOnlyDescendants(targetPage.path, user);
    }
    else {
      const factory = new PageCursorsForDescendantsFactory(user, targetPage, true);
      readStream = await factory.generateReadable();
    }


    const deleteDescendants = this.deleteDescendants.bind(this);
    let count = 0;
    let nDeletedNonEmptyPages = 0; // used for updating descendantCount

    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        nDeletedNonEmptyPages += batch.filter(d => !d.isEmpty).length;

        try {
          count += batch.length;
          await deleteDescendants(batch, user);
          logger.debug(`Deleting pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('deleteDescendants error on add anyway: ', err);
        }

        callback();
      },
      final(callback) {
        logger.debug(`Deleting pages has completed: (totalCount=${count})`);

        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);

    await streamToPromise(writeStream);

    return nDeletedNonEmptyPages;
  }

  private async deleteCompletelyOperation(pageIds, pagePaths) {
    // Delete Bookmarks, Attachments, Revisions, Pages and emit delete
    const Bookmark = this.crowi.model('Bookmark');
    const Comment = this.crowi.model('Comment');
    const Page = this.crowi.model('Page');
    const PageTagRelation = this.crowi.model('PageTagRelation');
    const ShareLink = this.crowi.model('ShareLink');
    const Revision = this.crowi.model('Revision');
    const Attachment = this.crowi.model('Attachment');
    const PageRedirect = mongoose.model('PageRedirect') as unknown as PageRedirectModel;

    const { attachmentService } = this.crowi;
    const attachments = await Attachment.find({ page: { $in: pageIds } });

    return Promise.all([
      Bookmark.deleteMany({ page: { $in: pageIds } }),
      Comment.deleteMany({ page: { $in: pageIds } }),
      PageTagRelation.deleteMany({ relatedPage: { $in: pageIds } }),
      ShareLink.deleteMany({ relatedPage: { $in: pageIds } }),
      Revision.deleteMany({ pageId: { $in: pageIds } }),
      Page.deleteMany({ _id: { $in: pageIds } }),
      PageRedirect.deleteMany({ $or: [{ fromPath: { $in: pagePaths } }, { toPath: { $in: pagePaths } }] }),
      attachmentService.removeAllAttachments(attachments),
    ]);
  }

  // delete multiple pages
  private async deleteMultipleCompletely(pages, user, options = {}) {
    const ids = pages.map(page => (page._id));
    const paths = pages.map(page => (page.path));

    logger.debug('Deleting completely', paths);

    await this.deleteCompletelyOperation(ids, paths);

    this.pageEvent.emit('syncDescendantsDelete', pages, user); // update as renamed page

    return;
  }

  async deleteCompletely(page, user, options = {}, isRecursively = false, preventEmitting = false) {
    /*
     * Common Operation
     */
    const Page = mongoose.model('Page') as PageModel;

    if (isTopPage(page.path)) {
      throw Error('It is forbidden to delete the top page');
    }

    if (page.isEmpty && !isRecursively) {
      throw Error('Page not found.');
    }

    // v4 compatible process
    const shouldUseV4Process = this.shouldUseV4Process(page);
    if (shouldUseV4Process) {
      return this.deleteCompletelyV4(page, user, options, isRecursively, preventEmitting);
    }

    const canOperate = await this.crowi.pageOperationService.canOperate(isRecursively, page.path, null);
    if (!canOperate) {
      throw Error(`Cannot operate deleteCompletely from path "${page.path}" right now.`);
    }

    const ids = [page._id];
    const paths = [page.path];

    logger.debug('Deleting completely', paths);

    // 1. update descendantCount
    if (isRecursively) {
      const inc = page.isEmpty ? -page.descendantCount : -(page.descendantCount + 1);
      await this.updateDescendantCountOfAncestors(page.parent, inc, true);
    }
    else {
      // replace with an empty page
      const shouldReplace = await Page.exists({ parent: page._id });
      let pageToUpdateDescendantCount = page;
      if (shouldReplace) {
        pageToUpdateDescendantCount = await Page.replaceTargetWithPage(page);
      }
      await this.updateDescendantCountOfAncestors(pageToUpdateDescendantCount.parent, -1, true);
    }
    // 2. then delete target completely
    await this.deleteCompletelyOperation(ids, paths);

    // delete leaf empty pages
    await Page.removeLeafEmptyPagesRecursively(page.parent);

    if (!page.isEmpty && !preventEmitting) {
      this.pageEvent.emit('deleteCompletely', page, user);
    }

    if (isRecursively) {
      let pageOp;
      try {
        pageOp = await PageOperation.create({
          actionType: PageActionType.DeleteCompletely,
          actionStage: PageActionStage.Main,
          page,
          user,
          fromPath: page.path,
          options,
        });
      }
      catch (err) {
        logger.error('Failed to create PageOperation document.', err);
        throw err;
      }
      /*
       * Main Operation
       */
      this.deleteCompletelyRecursivelyMainOperation(page, user, options, pageOp._id);
    }

    return;
  }

  async deleteCompletelyRecursivelyMainOperation(page, user, options, pageOpId: ObjectIdLike): Promise<void> {
    await this.deleteCompletelyDescendantsWithStream(page, user, options, false);

    await PageOperation.findByIdAndDelete(pageOpId);

    // no sub operation available
  }

  private async deleteCompletelyV4(page, user, options = {}, isRecursively = false, preventEmitting = false) {
    const ids = [page._id];
    const paths = [page.path];

    logger.debug('Deleting completely', paths);

    await this.deleteCompletelyOperation(ids, paths);

    if (isRecursively) {
      this.deleteCompletelyDescendantsWithStream(page, user, options);
    }

    if (!page.isEmpty && !preventEmitting) {
      this.pageEvent.emit('deleteCompletely', page, user);
    }

    return;
  }

  async emptyTrashPage(user, options = {}) {
    return this.deleteCompletelyDescendantsWithStream({ path: '/trash' }, user, options);
  }

  /**
   * Create delete completely stream
   */
  private async deleteCompletelyDescendantsWithStream(targetPage, user, options = {}, shouldUseV4Process = true): Promise<number> {
    let readStream;

    if (shouldUseV4Process) { // pages don't have parents
      readStream = await this.generateReadStreamToOperateOnlyDescendants(targetPage.path, user);
    }
    else {
      const factory = new PageCursorsForDescendantsFactory(user, targetPage, true);
      readStream = await factory.generateReadable();
    }

    let count = 0;
    let nDeletedNonEmptyPages = 0; // used for updating descendantCount

    const deleteMultipleCompletely = this.deleteMultipleCompletely.bind(this);
    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        nDeletedNonEmptyPages += batch.filter(d => !d.isEmpty).length;

        try {
          count += batch.length;
          await deleteMultipleCompletely(batch, user, options);
          logger.debug(`Adding pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('addAllPages error on add anyway: ', err);
        }

        callback();
      },
      final(callback) {
        logger.debug(`Adding pages has completed: (totalCount=${count})`);

        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);

    await streamToPromise(writeStream);

    return nDeletedNonEmptyPages;
  }

  // no need to separate Main Sub since it is devided into single page operations
  async deleteMultiplePages(pagesToDelete, user, options): Promise<void> {
    const { isRecursively, isCompletely } = options;

    if (pagesToDelete.length > LIMIT_FOR_MULTIPLE_PAGE_OP) {
      throw Error(`The maximum number of pages is ${LIMIT_FOR_MULTIPLE_PAGE_OP}.`);
    }

    // omit duplicate paths if isRecursively true, omit empty pages if isRecursively false
    const pages = isRecursively ? omitDuplicateAreaPageFromPages(pagesToDelete) : pagesToDelete.filter(p => !p.isEmpty);

    if (isCompletely) {
      for await (const page of pages) {
        await this.deleteCompletely(page, user, {}, isRecursively);
      }
    }
    else {
      for await (const page of pages) {
        await this.deletePage(page, user, {}, isRecursively);
      }
    }
  }

  // use the same process in both v4 and v5
  private async revertDeletedDescendants(pages, user) {
    const Page = this.crowi.model('Page');
    const PageRedirect = mongoose.model('PageRedirect') as unknown as PageRedirectModel;

    const revertPageOperations: any[] = [];
    const fromPathsToDelete: string[] = [];

    pages.forEach((page) => {
      // e.g. page.path = /trash/test, toPath = /test
      const toPath = Page.getRevertDeletedPageName(page.path);
      revertPageOperations.push({
        updateOne: {
          filter: { _id: page._id },
          update: {
            $set: {
              path: toPath, status: Page.STATUS_PUBLISHED, lastUpdateUser: user._id, deleteUser: null, deletedAt: null,
            },
          },
        },
      });

      fromPathsToDelete.push(page.path);
    });

    try {
      await Page.bulkWrite(revertPageOperations);
      await PageRedirect.deleteMany({ fromPath: { $in: fromPathsToDelete } });
    }
    catch (err) {
      if (err.code !== 11000) {
        throw new Error(`Failed to revert pages: ${err}`);
      }
    }
  }

  async revertDeletedPage(page, user, options = {}, isRecursively = false) {
    /*
     * Common Operation
     */
    const Page = this.crowi.model('Page');
    const PageTagRelation = this.crowi.model('PageTagRelation');

    // 1. Separate v4 & v5 process
    const shouldUseV4Process = this.shouldUseV4ProcessForRevert(page);
    if (shouldUseV4Process) {
      return this.revertDeletedPageV4(page, user, options, isRecursively);
    }

    const newPath = Page.getRevertDeletedPageName(page.path);

    const canOperate = await this.crowi.pageOperationService.canOperate(isRecursively, page.path, newPath);
    if (!canOperate) {
      throw Error(`Cannot operate revert from path "${page.path}" right now.`);
    }

    const includeEmpty = true;
    const originPage = await Page.findByPath(newPath, includeEmpty);

    // throw if any page already exists
    if (originPage != null) {
      throw Error(`This page cannot be reverted since a page with path "${originPage.path}" already exists. Rename the existing pages first.`);
    }

    // 2. Revert target
    const parent = await Page.getParentAndFillAncestors(newPath, user);
    const updatedPage = await Page.findByIdAndUpdate(page._id, {
      $set: {
        path: newPath, status: Page.STATUS_PUBLISHED, lastUpdateUser: user._id, deleteUser: null, deletedAt: null, parent: parent._id, descendantCount: 0,
      },
    }, { new: true });
    await PageTagRelation.updateMany({ relatedPage: page._id }, { $set: { isPageTrashed: false } });

    if (!isRecursively) {
      await this.updateDescendantCountOfAncestors(parent._id, 1, true);
    }
    else {
      let pageOp;
      try {
        pageOp = await PageOperation.create({
          actionType: PageActionType.Revert,
          actionStage: PageActionStage.Main,
          page,
          user,
          fromPath: page.path,
          toPath: newPath,
          options,
        });
      }
      catch (err) {
        logger.error('Failed to create PageOperation document.', err);
        throw err;
      }
      /*
       * Resumable Operation
       */
      this.revertRecursivelyMainOperation(page, user, options, pageOp._id);
    }

    return updatedPage;
  }

  async revertRecursivelyMainOperation(page, user, options, pageOpId: ObjectIdLike): Promise<void> {
    const Page = mongoose.model('Page') as unknown as PageModel;

    await this.revertDeletedDescendantsWithStream(page, user, options, false);

    const newPath = Page.getRevertDeletedPageName(page.path);
    // normalize parent of descendant pages
    const shouldNormalize = this.shouldNormalizeParent(page);
    if (shouldNormalize) {
      try {
        await this.normalizeParentAndDescendantCountOfDescendants(newPath, user);
        logger.info(`Successfully normalized reverted descendant pages under "${newPath}"`);
      }
      catch (err) {
        logger.error('Failed to normalize descendants afrer revert:', err);
        throw err;
      }
    }

    // Set to Sub
    const pageOp = await PageOperation.findByIdAndUpdatePageActionStage(pageOpId, PageActionStage.Sub);
    if (pageOp == null) {
      throw Error('PageOperation document not found');
    }

    /*
     * Sub Operation
     */
    await this.revertRecursivelySubOperation(newPath, pageOp._id);
  }

  async revertRecursivelySubOperation(newPath: string, pageOpId: ObjectIdLike): Promise<void> {
    const Page = mongoose.model('Page') as unknown as PageModel;

    const newTarget = await Page.findOne({ path: newPath }); // only one page will be found since duplicating to existing path is forbidden

    if (newTarget == null) {
      throw Error('No reverted page found. Something might have gone wrong in revertRecursivelyMainOperation.');
    }

    // update descendantCount of ancestors'
    await this.updateDescendantCountOfAncestors(newTarget.parent as ObjectIdLike, newTarget.descendantCount + 1, true);

    await PageOperation.findByIdAndDelete(pageOpId);
  }

  private async revertDeletedPageV4(page, user, options = {}, isRecursively = false) {
    const Page = this.crowi.model('Page');
    const PageTagRelation = this.crowi.model('PageTagRelation');

    const newPath = Page.getRevertDeletedPageName(page.path);
    const originPage = await Page.findByPath(newPath);
    if (originPage != null) {
      throw Error(`This page cannot be reverted since a page with path "${originPage.path}" already exists.`);
    }

    if (isRecursively) {
      this.revertDeletedDescendantsWithStream(page, user, options);
    }

    page.status = Page.STATUS_PUBLISHED;
    page.lastUpdateUser = user;
    debug('Revert deleted the page', page, newPath);
    const updatedPage = await Page.findByIdAndUpdate(page._id, {
      $set: {
        path: newPath, status: Page.STATUS_PUBLISHED, lastUpdateUser: user._id, deleteUser: null, deletedAt: null,
      },
    }, { new: true });
    await PageTagRelation.updateMany({ relatedPage: page._id }, { $set: { isPageTrashed: false } });

    return updatedPage;
  }

  /**
   * Create revert stream
   */
  private async revertDeletedDescendantsWithStream(targetPage, user, options = {}, shouldUseV4Process = true): Promise<number> {
    if (shouldUseV4Process) {
      return this.revertDeletedDescendantsWithStreamV4(targetPage, user, options);
    }

    const readStream = await this.generateReadStreamToOperateOnlyDescendants(targetPage.path, user);

    const revertDeletedDescendants = this.revertDeletedDescendants.bind(this);
    let count = 0;
    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        try {
          count += batch.length;
          await revertDeletedDescendants(batch, user);
          logger.debug(`Reverting pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('revertPages error on add anyway: ', err);
        }

        callback();
      },
      async final(callback) {
        logger.debug(`Reverting pages has completed: (totalCount=${count})`);

        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);

    await streamToPromise(writeStream);

    return count;
  }

  private async revertDeletedDescendantsWithStreamV4(targetPage, user, options = {}) {
    const readStream = await this.generateReadStreamToOperateOnlyDescendants(targetPage.path, user);

    const revertDeletedDescendants = this.revertDeletedDescendants.bind(this);
    let count = 0;
    const writeStream = new Writable({
      objectMode: true,
      async write(batch, encoding, callback) {
        try {
          count += batch.length;
          await revertDeletedDescendants(batch, user);
          logger.debug(`Reverting pages progressing: (count=${count})`);
        }
        catch (err) {
          logger.error('revertPages error on add anyway: ', err);
        }

        callback();
      },
      final(callback) {
        logger.debug(`Reverting pages has completed: (totalCount=${count})`);

        callback();
      },
    });

    readStream
      .pipe(createBatchStream(BULK_REINDEX_SIZE))
      .pipe(writeStream);

    await streamToPromise(readStream);

    return count;
  }


  async handlePrivatePagesForGroupsToDelete(groupsToDelete, action, transferToUserGroupId, user) {
    const Page = this.crowi.model('Page');
    const pages = await Page.find({ grantedGroup: { $in: groupsToDelete } });

    switch (action) {
      case 'public':
        await Page.publicizePages(pages);
        break;
      case 'delete':
        return this.deleteMultipleCompletely(pages, user);
      case 'transfer':
        await Page.transferPagesToGroup(pages, transferToUserGroupId);
        break;
      default:
        throw new Error('Unknown action for private pages');
    }
  }

  private extractStringIds(refs: Ref<HasObjectId>[]) {
    return refs.map((ref: Ref<HasObjectId>) => {
      return (typeof ref === 'string') ? ref : ref._id.toString();
    });
  }

  constructBasicPageInfo(page: IPage, isGuestUser?: boolean): IPageInfo | IPageInfoForEntity {
    const isMovable = isGuestUser ? false : isMovablePage(page.path);

    if (page.isEmpty) {
      return {
        isV5Compatible: true,
        isEmpty: true,
        isMovable,
        isDeletable: true,
        isAbleToDeleteCompletely: true,
        isRevertible: false,
      };
    }

    const likers = page.liker.slice(0, 15) as Ref<IUserHasId>[];
    const seenUsers = page.seenUsers.slice(0, 15) as Ref<IUserHasId>[];

    return {
      isV5Compatible: isTopPage(page.path) || page.parent != null,
      isEmpty: false,
      sumOfLikers: page.liker.length,
      likerIds: this.extractStringIds(likers),
      seenUserIds: this.extractStringIds(seenUsers),
      sumOfSeenUsers: page.seenUsers.length,
      isMovable,
      isDeletable: isMovable,
      isAbleToDeleteCompletely: false,
      isRevertible: isTrashPage(page.path),
    };

  }

  async shortBodiesMapByPageIds(pageIds: ObjectId[] = [], user): Promise<Record<string, string | null>> {
    const Page = mongoose.model('Page') as unknown as PageModel;
    const MAX_LENGTH = 350;

    // aggregation options
    let userGroups;
    if (user != null && userGroups == null) {
      const UserGroupRelation = mongoose.model('UserGroupRelation') as any; // Typescriptize model
      userGroups = await UserGroupRelation.findAllUserGroupIdsRelatedToUser(user);
    }
    const viewerCondition = Page.generateGrantCondition(user, userGroups);
    const filterByIds = {
      _id: { $in: pageIds },
    };

    let pages;
    try {
      pages = await Page
        .aggregate([
          // filter by pageIds
          {
            $match: filterByIds,
          },
          // filter by viewer
          {
            $match: viewerCondition,
          },
          // lookup: https://docs.mongodb.com/v4.4/reference/operator/aggregation/lookup/
          {
            $lookup: {
              from: 'revisions',
              let: { localRevision: '$revision' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: ['$_id', '$$localRevision'],
                    },
                  },
                },
                {
                  $project: {
                    // What is $substrCP?
                    // see: https://stackoverflow.com/questions/43556024/mongodb-error-substrbytes-invalid-range-ending-index-is-in-the-middle-of-a-ut/43556249
                    revision: { $substrCP: ['$body', 0, MAX_LENGTH] },
                  },
                },
              ],
              as: 'revisionData',
            },
          },
          // projection
          {
            $project: {
              _id: 1,
              revisionData: 1,
            },
          },
        ]).exec();
    }
    catch (err) {
      logger.error('Error occurred while generating shortBodiesMap');
      throw err;
    }

    const shortBodiesMap = {};
    pages.forEach((page) => {
      shortBodiesMap[page._id] = page.revisionData?.[0]?.revision;
    });

    return shortBodiesMap;
  }

  private async createAndSendNotifications(page, user, action) {
    const { activityService, inAppNotificationService } = this.crowi;

    const snapshot = stringifySnapshot(page);

    // Create activity
    const parameters = {
      user: user._id,
      targetModel: ActivityDefine.MODEL_PAGE,
      target: page,
      action,
    };
    const activity = await activityService.createByParameters(parameters);

    // Get user to be notified
    const targetUsers = await activity.getNotificationTargetUsers();

    // Create and send notifications
    await inAppNotificationService.upsertByActivity(targetUsers, activity, snapshot);
    await inAppNotificationService.emitSocketIo(targetUsers);
  }

  async normalizeParentByPageIds(pageIds: ObjectIdLike[], user, isRecursively: boolean): Promise<void> {
    const Page = mongoose.model('Page') as unknown as PageModel;

    if (isRecursively) {
      const pages = await Page.findByIdsAndViewer(pageIds, user, null);

      // DO NOT await !!
      this.normalizeParentRecursivelyByPages(pages, user);

      return;
    }

    for await (const pageId of pageIds) {
      const page = await Page.findById(pageId);
      if (page == null) {
        continue;
      }

      try {
        const canOperate = await this.crowi.pageOperationService.canOperate(false, page.path, page.path);
        if (!canOperate) {
          throw Error(`Cannot operate normalizeParent to path "${page.path}" right now.`);
        }

        const normalizedPage = await this.normalizeParentByPage(page, user);

        if (normalizedPage == null) {
          logger.error(`Failed to update descendantCount of page of id: "${pageId}"`);
        }
      }
      catch (err) {
        logger.error('Something went wrong while normalizing parent.', err);
        // socket.emit('normalizeParentByPageIds', { error: err.message }); TODO: use socket to tell user
      }
    }
  }

  private async normalizeParentByPage(page, user) {
    const Page = mongoose.model('Page') as unknown as PageModel;

    const {
      path, grant, grantedUsers: grantedUserIds, grantedGroup: grantedGroupId,
    } = page;

    // check if any page exists at target path already
    const existingPage = await Page.findOne({ path, parent: { $ne: null } });
    if (existingPage != null && !existingPage.isEmpty) {
      throw Error('Page already exists. Please rename the page to continue.');
    }

    /*
     * UserGroup & Owner validation
     */
    if (grant !== Page.GRANT_RESTRICTED) {
      let isGrantNormalized = false;
      try {
        const shouldCheckDescendants = true;

        isGrantNormalized = await this.crowi.pageGrantService.isGrantNormalized(user, path, grant, grantedUserIds, grantedGroupId, shouldCheckDescendants);
      }
      catch (err) {
        logger.error(`Failed to validate grant of page at "${path}"`, err);
        throw err;
      }
      if (!isGrantNormalized) {
        throw Error('This page cannot be migrated since the selected grant or grantedGroup is not assignable to this page.');
      }
    }
    else {
      throw Error('Restricted pages can not be migrated');
    }

    let updatedPage;

    // replace if empty page exists
    if (existingPage != null && existingPage.isEmpty) {
      await Page.replaceTargetWithPage(existingPage, page, true);
      updatedPage = await Page.findById(page._id);
    }
    else {
      const parent = await Page.getParentAndFillAncestors(page.path, user);
      updatedPage = await Page.findOneAndUpdate({ _id: page._id }, { parent: parent._id }, { new: true });
    }

    // Update descendantCount
    const inc = 1;
    await this.updateDescendantCountOfAncestors(updatedPage.parent, inc, true);

    return updatedPage;
  }

  async normalizeParentRecursivelyByPages(pages, user): Promise<void> {
    /*
     * Main Operation
     */
    if (pages == null || pages.length === 0) {
      logger.error('pageIds is null or 0 length.');
      return;
    }

    if (pages.length > LIMIT_FOR_MULTIPLE_PAGE_OP) {
      throw Error(`The maximum number of pageIds allowed is ${LIMIT_FOR_MULTIPLE_PAGE_OP}.`);
    }

    const pagesToNormalize = omitDuplicateAreaPageFromPages(pages);

    let normalizablePages;
    let nonNormalizablePages;
    try {
      [normalizablePages, nonNormalizablePages] = await this.crowi.pageGrantService.separateNormalizableAndNotNormalizablePages(user, pagesToNormalize);
    }
    catch (err) {
      throw err;
    }

    if (normalizablePages.length === 0) {
      // socket.emit('normalizeParentRecursivelyByPages', { error: err.message }); TODO: use socket to tell user
      return;
    }

    if (nonNormalizablePages.length !== 0) {
      // TODO: iterate nonNormalizablePages and send socket error to client so that the user can know which path failed to migrate
      // socket.emit('normalizeParentRecursivelyByPages', { error: err.message }); TODO: use socket to tell user
    }

    /*
     * Main Operation (s)
     */
    for await (const page of normalizablePages) {
      const canOperate = await this.crowi.pageOperationService.canOperate(true, page.path, page.path);
      if (!canOperate) {
        throw Error(`Cannot operate normalizeParentRecursiively to path "${page.path}" right now.`);
      }

      let pageOp;
      try {
        pageOp = await PageOperation.create({
          actionType: PageActionType.NormalizeParent,
          actionStage: PageActionStage.Main,
          page,
          user,
          fromPath: page.path,
          toPath: page.path,
        });
      }
      catch (err) {
        logger.error('Failed to create PageOperation document.', err);
        throw err;
      }
      await this.normalizeParentRecursivelyMainOperation(page, user, pageOp._id);
    }
  }

  async normalizeParentRecursivelyMainOperation(page, user, pageOpId: ObjectIdLike): Promise<void> {
    // Save prevDescendantCount for sub-operation
    const Page = mongoose.model('Page') as unknown as PageModel;
    const { PageQueryBuilder } = Page;
    const builder = new PageQueryBuilder(Page.findOne(), true);
    builder.addConditionAsMigrated();
    const exPage = await builder.query.exec();
    const options = { prevDescendantCount: exPage?.descendantCount ?? 0 };

    try {
      await this.normalizeParentRecursively([page.path], user);
    }
    catch (err) {
      logger.error('V5 initial miration failed.', err);
      // socket.emit('normalizeParentRecursivelyByPageIds', { error: err.message }); TODO: use socket to tell user

      throw err;
    }

    // Set to Sub
    const pageOp = await PageOperation.findByIdAndUpdatePageActionStage(pageOpId, PageActionStage.Sub);
    if (pageOp == null) {
      throw Error('PageOperation document not found');
    }

    await this.normalizeParentRecursivelySubOperation(page, user, pageOp._id, options);
  }

  async normalizeParentRecursivelySubOperation(page, user, pageOpId: ObjectIdLike, options: {prevDescendantCount: number}): Promise<void> {
    const Page = mongoose.model('Page') as unknown as PageModel;

    try {
      // update descendantCount of self and descendant pages first
      await this.updateDescendantCountOfSelfAndDescendants(page.path);

      // find pages again to get updated descendantCount
      // then calculate inc
      const pageAfterUpdatingDescendantCount = await Page.findByIdAndViewer(page._id, user);
      if (pageAfterUpdatingDescendantCount == null) {
        throw Error('Page not found after updating descendantCount');
      }

      const { prevDescendantCount } = options;
      const newDescendantCount = pageAfterUpdatingDescendantCount.descendantCount;
      const inc = (newDescendantCount - prevDescendantCount) + 1;
      await this.updateDescendantCountOfAncestors(page._id, inc, false);
    }
    catch (err) {
      logger.error('Failed to update descendantCount after normalizing parent:', err);
      throw Error(`Failed to update descendantCount after normalizing parent: ${err}`);
    }

    await PageOperation.findByIdAndDelete(pageOpId);
  }

  async _isPagePathIndexUnique() {
    const Page = this.crowi.model('Page');
    const now = (new Date()).toString();
    const path = `growi_check_is_path_index_unique_${now}`;

    let isUnique = false;

    try {
      await Page.insertMany([
        { path },
        { path },
      ]);
    }
    catch (err) {
      if (err?.code === 11000) { // Error code 11000 indicates the index is unique
        isUnique = true;
        logger.info('Page path index is unique.');
      }
      else {
        throw err;
      }
    }
    finally {
      await Page.deleteMany({ path: { $regex: new RegExp('growi_check_is_path_index_unique', 'g') } });
    }


    return isUnique;
  }

  // TODO: use socket to send status to the client
  async normalizeAllPublicPages() {
    // const socket = this.crowi.socketIoService.getAdminSocket();

    let isUnique;
    try {
      isUnique = await this._isPagePathIndexUnique();
    }
    catch (err) {
      logger.error('Failed to check path index status', err);
      throw err;
    }

    // drop unique index first
    if (isUnique) {
      try {
        await this._v5NormalizeIndex();
      }
      catch (err) {
        logger.error('V5 index normalization failed.', err);
        // socket.emit('v5IndexNormalizationFailed', { error: err.message });
        throw err;
      }
    }

    // then migrate
    try {
      await this.normalizeParentRecursively(['/'], null);
    }
    catch (err) {
      logger.error('V5 initial miration failed.', err);
      // socket.emit('v5InitialMirationFailed', { error: err.message });

      throw err;
    }

    // update descendantCount of all public pages
    try {
      await this.updateDescendantCountOfSelfAndDescendants('/');
      logger.info('Successfully updated all descendantCount of public pages.');
    }
    catch (err) {
      logger.error('Failed updating descendantCount of public pages.', err);
      throw err;
    }

    await this._setIsV5CompatibleTrue();
  }

  private async _setIsV5CompatibleTrue() {
    try {
      await this.crowi.configManager.updateConfigsInTheSameNamespace('crowi', {
        'app:isV5Compatible': true,
      });
      logger.info('Successfully migrated all public pages.');
    }
    catch (err) {
      logger.warn('Failed to update app:isV5Compatible to true.');
      throw err;
    }
  }

  private async normalizeParentAndDescendantCountOfDescendants(path: string, user): Promise<void> {
    await this.normalizeParentRecursively([path], user);

    // update descendantCount of descendant pages
    await this.updateDescendantCountOfSelfAndDescendants(path);
  }

  /**
   * Normalize parent attribute by passing paths and user.
   * @param paths Pages under this paths value will be updated.
   * @param user To be used to filter pages to update. If null, only public pages will be updated.
   * @returns Promise<void>
   */
  async normalizeParentRecursively(paths: string[], user: any | null): Promise<void> {
    const Page = mongoose.model('Page') as unknown as PageModel;

    const ancestorPaths = paths.flatMap(p => collectAncestorPaths(p, []));
    // targets' descendants
    const pathAndRegExpsToNormalize: (RegExp | string)[] = paths
      .map(p => new RegExp(`^${escapeStringRegexp(addTrailingSlash(p))}`, 'i'));
    // include targets' path
    pathAndRegExpsToNormalize.push(...paths);

    // determine UserGroup condition
    let userGroups = null;
    if (user != null) {
      const UserGroupRelation = mongoose.model('UserGroupRelation') as any; // TODO: Typescriptize model
      userGroups = await UserGroupRelation.findAllUserGroupIdsRelatedToUser(user);
    }

    const grantFiltersByUser: { $or: any[] } = Page.generateGrantCondition(user, userGroups);

    return this._normalizeParentRecursively(pathAndRegExpsToNormalize, ancestorPaths, grantFiltersByUser, user);
  }

  private async _normalizeParentRecursively(
      pathOrRegExps: (RegExp | string)[], publicPathsToNormalize: string[], grantFiltersByUser: { $or: any[] }, user, count = 0, skiped = 0, isFirst = true,
  ): Promise<void> {
    const BATCH_SIZE = 100;
    const PAGES_LIMIT = 1000;

    const socket = this.crowi.socketIoService.getAdminSocket();

    const Page = mongoose.model('Page') as unknown as PageModel;
    const { PageQueryBuilder } = Page;

    // Build filter
    const andFilter: any = {
      $and: [
        {
          parent: null,
          status: Page.STATUS_PUBLISHED,
          path: { $ne: '/' },
        },
      ],
    };
    const orFilter: any = { $or: [] };
    // specified pathOrRegExps
    if (pathOrRegExps.length > 0) {
      orFilter.$or.push(
        {
          path: { $in: pathOrRegExps },
        },
      );
    }
    // not specified but ancestors of specified pathOrRegExps
    if (publicPathsToNormalize.length > 0) {
      orFilter.$or.push(
        {
          path: { $in: publicPathsToNormalize },
          grant: Page.GRANT_PUBLIC, // use only public pages to complete the tree
        },
      );
    }

    // Merge filters
    const mergedFilter = {
      $and: [
        { $and: [grantFiltersByUser, ...andFilter.$and] },
        { $or: orFilter.$or },
      ],
    };

    let baseAggregation = Page
      .aggregate([
        { $match: mergedFilter },
        {
          $project: { // minimize data to fetch
            _id: 1,
            path: 1,
          },
        },
      ]);

    // Limit pages to get
    const total = await Page.countDocuments(mergedFilter);
    if (isFirst) {
      socket.emit(SocketEventName.PMStarted, { total });
    }
    if (total > PAGES_LIMIT) {
      baseAggregation = baseAggregation.limit(Math.floor(total * 0.3));
    }

    const pagesStream = await baseAggregation.cursor({ batchSize: BATCH_SIZE });
    const batchStream = createBatchStream(BATCH_SIZE);

    let shouldContinue = true;
    let nextCount = count;
    let nextSkiped = skiped;

    const migratePagesStream = new Writable({
      objectMode: true,
      async write(pages, encoding, callback) {
        const parentPaths = Array.from(new Set<string>(pages.map(p => pathlib.dirname(p.path))));

        // 1. Remove unnecessary empty pages & reset parent for pages which had had those empty pages
        const pageIdsToNotDelete = pages.map(p => p._id);
        const emptyPagePathsToDelete = pages.map(p => p.path);

        const builder1 = new PageQueryBuilder(Page.find({ isEmpty: true }, { _id: 1 }), true);
        builder1.addConditionToListByPathsArray(emptyPagePathsToDelete);
        builder1.addConditionToExcludeByPageIdsArray(pageIdsToNotDelete);

        const emptyPagesToDelete = await builder1.query.lean().exec();
        const resetParentOperations = emptyPagesToDelete.map((p) => {
          return {
            updateOne: {
              filter: {
                parent: p._id,
              },
              update: {
                parent: null,
              },
            },
          };
        });

        await Page.bulkWrite(resetParentOperations);
        await Page.removeEmptyPages(pageIdsToNotDelete, emptyPagePathsToDelete);

        // 2. Create lacking parents as empty pages
        const orFilters = [
          { path: '/' },
          { path: { $in: publicPathsToNormalize }, grant: Page.GRANT_PUBLIC, status: Page.STATUS_PUBLISHED },
          { path: { $in: publicPathsToNormalize }, parent: { $ne: null }, status: Page.STATUS_PUBLISHED },
          { path: { $nin: publicPathsToNormalize }, status: Page.STATUS_PUBLISHED },
        ];
        const filterForApplicableAncestors = { $or: orFilters };
        await Page.createEmptyPagesByPaths(parentPaths, user, false, filterForApplicableAncestors);

        // 3. Find parents
        const addGrantCondition = (builder) => {
          builder.query = builder.query.and(grantFiltersByUser);

          return builder;
        };
        const builder2 = new PageQueryBuilder(Page.find(), true);
        addGrantCondition(builder2);
        const parents = await builder2
          .addConditionToListByPathsArray(parentPaths)
          .addConditionToFilterByApplicableAncestors(publicPathsToNormalize)
          .query
          .lean()
          .exec();

        // Normalize all siblings for each page
        const updateManyOperations = parents.map((parent) => {
          const parentId = parent._id;

          // Build filter
          const parentPathEscaped = escapeStringRegexp(parent.path === '/' ? '' : parent.path); // adjust the path for RegExp
          const filter: any = {
            $and: [
              {
                path: { $regex: new RegExp(`^${parentPathEscaped}(\\/[^/]+)\\/?$`, 'i') }, // see: regexr.com/6889f (e.g. /parent/any_child or /any_level1)
              },
              filterForApplicableAncestors,
              grantFiltersByUser,
            ],
          };

          return {
            updateMany: {
              filter,
              update: {
                parent: parentId,
              },
            },
          };
        });
        try {
          const res = await Page.bulkWrite(updateManyOperations);

          nextCount += res.result.nModified;
          nextSkiped += res.result.writeErrors.length;
          logger.info(`Page migration processing: (migratedPages=${res.result.nModified})`);

          socket.emit(SocketEventName.PMMigrating, { count: nextCount });
          socket.emit(SocketEventName.PMErrorCount, { skip: nextSkiped });

          // Throw if any error is found
          if (res.result.writeErrors.length > 0) {
            logger.error('Failed to migrate some pages', res.result.writeErrors);
            socket.emit(SocketEventName.PMEnded, { isSucceeded: false });
            throw Error('Failed to migrate some pages');
          }

          // Finish migration if no modification occurred
          if (res.result.nModified === 0 && res.result.nMatched === 0) {
            shouldContinue = false;
            logger.error('Migration is unable to continue', 'parentPaths:', parentPaths, 'bulkWriteResult:', res);
            socket.emit(SocketEventName.PMEnded, { isSucceeded: false });
          }
        }
        catch (err) {
          logger.error('Failed to update page.parent.', err);
          throw err;
        }

        callback();
      },
      final(callback) {
        callback();
      },
    });

    pagesStream
      .pipe(batchStream)
      .pipe(migratePagesStream);

    await streamToPromise(migratePagesStream);

    if (await Page.exists(mergedFilter) && shouldContinue) {
      return this._normalizeParentRecursively(pathOrRegExps, publicPathsToNormalize, grantFiltersByUser, user, nextCount, nextSkiped, false);
    }

    // End
    socket.emit(SocketEventName.PMEnded, { isSucceeded: true });
  }

  private async _v5NormalizeIndex() {
    const collection = mongoose.connection.collection('pages');

    try {
      // drop pages.path_1 indexes
      await collection.dropIndex('path_1');
      logger.info('Succeeded to drop unique indexes from pages.path.');
    }
    catch (err) {
      logger.warn('Failed to drop unique indexes from pages.path.', err);
      throw err;
    }

    try {
      // create indexes without
      await collection.createIndex({ path: 1 }, { unique: false });
      logger.info('Succeeded to create non-unique indexes on pages.path.');
    }
    catch (err) {
      logger.warn('Failed to create non-unique indexes on pages.path.', err);
      throw err;
    }
  }

  async countPagesCanNormalizeParentByUser(user): Promise<number> {
    if (user == null) {
      throw Error('user is required');
    }

    const Page = mongoose.model('Page') as unknown as PageModel;
    const { PageQueryBuilder } = Page;

    const builder = new PageQueryBuilder(Page.count(), false);
    await builder.addConditionAsMigratablePages(user);

    const nMigratablePages = await builder.query.exec();

    return nMigratablePages;
  }

  /**
   * update descendantCount of the following pages
   * - page that has the same path as the provided path
   * - pages that are descendants of the above page
   */
  async updateDescendantCountOfSelfAndDescendants(path: string): Promise<void> {
    const BATCH_SIZE = 200;
    const Page = this.crowi.model('Page');
    const { PageQueryBuilder } = Page;

    const builder = new PageQueryBuilder(Page.find(), true);
    builder.addConditionAsMigrated();
    builder.addConditionToListWithDescendants(path);
    builder.addConditionToSortPagesByDescPath();

    const aggregatedPages = await builder.query.lean().cursor({ batchSize: BATCH_SIZE });


    const recountWriteStream = new Writable({
      objectMode: true,
      async write(pageDocuments, encoding, callback) {
        for await (const document of pageDocuments) {
          const descendantCount = await Page.recountDescendantCount(document._id);
          await Page.findByIdAndUpdate(document._id, { descendantCount });
        }
        callback();
      },
      final(callback) {
        callback();
      },
    });
    aggregatedPages
      .pipe(createBatchStream(BATCH_SIZE))
      .pipe(recountWriteStream);

    await streamToPromise(recountWriteStream);
  }

  // update descendantCount of all pages that are ancestors of a provided pageId by count
  async updateDescendantCountOfAncestors(pageId: ObjectIdLike, inc: number, shouldIncludeTarget: boolean): Promise<void> {
    const Page = this.crowi.model('Page');
    const ancestors = await Page.findAncestorsUsingParentRecursively(pageId, shouldIncludeTarget);
    const ancestorPageIds = ancestors.map(p => p._id);

    await Page.incrementDescendantCountOfPageIds(ancestorPageIds, inc);

    const updateDescCountData: UpdateDescCountRawData = Object.fromEntries(ancestors.map(p => [p._id.toString(), p.descendantCount + inc]));
    this.emitUpdateDescCount(updateDescCountData);
  }

  private emitUpdateDescCount(data: UpdateDescCountRawData): void {
    const socket = this.crowi.socketIoService.getDefaultSocket();

    socket.emit(SocketEventName.UpdateDescCount, data);
  }

}

export default PageService;
