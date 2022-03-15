import mongoose from 'mongoose';

import { getInstance } from '../setup-crowi';

describe('Page', () => {
  let crowi;
  let Page;
  let Revision;
  let User;
  let Tag;
  let PageTagRelation;
  let Bookmark;
  let Comment;
  let ShareLink;
  let PageRedirect;
  let xssSpy;

  let rootPage;
  let dummyUser1;

  // pass unless the data is one of [false, 0, '', null, undefined, NaN]
  const expectAllToBeTruthy = (dataList) => {
    dataList.forEach((data, i) => {
      if (data == null) { console.log(`index: ${i}`) }
      expect(data).toBeTruthy();
    });
  };

  beforeAll(async() => {
    crowi = await getInstance();
    await crowi.configManager.updateConfigsInTheSameNamespace('crowi', { 'app:isV5Compatible': true });

    jest.restoreAllMocks();
    User = mongoose.model('User');
    Page = mongoose.model('Page');
    Revision = mongoose.model('Revision');
    Tag = mongoose.model('Tag');
    PageTagRelation = mongoose.model('PageTagRelation');
    Bookmark = mongoose.model('Bookmark');
    Comment = mongoose.model('Comment');
    ShareLink = mongoose.model('ShareLink');
    PageRedirect = mongoose.model('PageRedirect');

    dummyUser1 = await User.findOne({ username: 'v5DummyUser1' });

    rootPage = await Page.findOne({ path: '/' });

    const pageIdCreate1 = new mongoose.Types.ObjectId();
    const pageIdCreate2 = new mongoose.Types.ObjectId();

    /**
     * create
     * mc_ => model create
     * emp => empty => page with isEmpty: true
     * pub => public => GRANT_PUBLIC
     */
    await Page.insertMany([
      {
        _id: pageIdCreate1,
        path: '/v5_empty_create_4',
        grant: Page.GRANT_PUBLIC,
        parent: rootPage._id,
        isEmpty: true,
      },
      {
        path: '/v5_empty_create_4/v5_create_5',
        grant: Page.GRANT_PUBLIC,
        creator: dummyUser1,
        lastUpdateUser: dummyUser1._id,
        parent: pageIdCreate1,
      },
      {
        _id: pageIdCreate2,
        path: '/mc1_emp',
        grant: Page.GRANT_PUBLIC,
        creator: dummyUser1,
        lastUpdateUser: dummyUser1._id,
        parent: rootPage._id,
        isEmpty: true,
      },
      {
        path: '/mc1_emp/mc2_pub',
        grant: Page.GRANT_PUBLIC,
        creator: dummyUser1,
        lastUpdateUser: dummyUser1._id,
        parent: pageIdCreate2,
      },
      {
        path: '/mc3_awl',
        grant: Page.GRANT_RESTRICTED,
        creator: dummyUser1,
        lastUpdateUser: dummyUser1._id,
      },
    ]);

    /**
     * update
     * mup_ => model update
     */
    const pageIdUpd1 = new mongoose.Types.ObjectId();
    const pageIdUpd2 = new mongoose.Types.ObjectId();
    const pageIdUpd3 = new mongoose.Types.ObjectId();
    const pageIdUpd4 = new mongoose.Types.ObjectId();

    await Page.insertMany([
      {
        _id: pageIdUpd1,
        path: '/mup1_empty',
        grant: Page.GRANT_PUBLIC,
        parent: rootPage._id,
        isEmpty: true,
      },
      {
        _id: pageIdUpd2,
        path: '/mup1_empty/mup2_public',
        grant: Page.GRANT_PUBLIC,
        parent: pageIdUpd1._id,
        creator: dummyUser1,
        lastUpdateUser: dummyUser1._id,
        isEmpty: false,
      },
      {
        _id: pageIdUpd3,
        path: '/mup3_empty/mup4_empty/mup5_link',
        grant: Page.GRANT_RESTRICTED,
        isEmpty: true,
      },
      {
        _id: pageIdUpd4,
        path: '/mup6_public',
        grant: Page.GRANT_PUBLIC,
        creator: dummyUser1,
        lastUpdateUser: dummyUser1._id,
        parent: rootPage._id,
      },
      {
        path: '/mup6_public/mup7_public',
        grant: Page.GRANT_PUBLIC,
        creator: dummyUser1,
        lastUpdateUser: dummyUser1._id,
        parent: pageIdUpd4,
      },
    ]);

  });
  describe('create', () => {

    test('Should create single page', async() => {
      const page = await Page.create('/v5_create1', 'create1', dummyUser1, {});
      expect(page).toBeTruthy();
      expect(page.parent).toStrictEqual(rootPage._id);
    });

    test('Should create empty-child and non-empty grandchild', async() => {
      const grandchildPage = await Page.create('/v5_empty_create2/v5_create_3', 'grandchild', dummyUser1, {});
      const childPage = await Page.findOne({ path: '/v5_empty_create2' });

      expect(childPage.isEmpty).toBe(true);
      expect(grandchildPage).toBeTruthy();
      expect(childPage).toBeTruthy();
      expect(childPage.parent).toStrictEqual(rootPage._id);
      expect(grandchildPage.parent).toStrictEqual(childPage._id);
    });

    test('Should create on empty page', async() => {
      const beforeCreatePage = await Page.findOne({ path: '/v5_empty_create_4' });
      expect(beforeCreatePage.isEmpty).toBe(true);

      const childPage = await Page.create('/v5_empty_create_4', 'body', dummyUser1, {});
      const grandchildPage = await Page.findOne({ parent: childPage._id });

      expect(childPage).toBeTruthy();
      expect(childPage.isEmpty).toBe(false);
      expect(childPage.revision.body).toBe('body');
      expect(grandchildPage).toBeTruthy();
      expect(childPage.parent).toStrictEqual(rootPage._id);
      expect(grandchildPage.parent).toStrictEqual(childPage._id);
    });

    describe('Creating a page using existing path', () => {
      test('with grant RESTRICTED should only create the page and change nothing else', async() => {
        const page1 = await Page.findOne({ path: '/mc1_emp' });
        const page2 = await Page.findOne({ path: '/mc1_emp/mc2_pub' });
        const count = await Page.count({ path: '/mc1_emp' });
        expectAllToBeTruthy([page1, page2]);
        expect(count).toBe(1);

        await Page.create('/mc1_emp', 'new body', dummyUser1, { grant: Page.GRANT_RESTRICTED });

        // AF => After Create
        const page1AF = await Page.findOne({ _id: page1._id });
        const page2AF = await Page.findOne({ _id: page2._id });
        const countAF = await Page.count({ path: '/mc1_emp' });
        const newPage = await Page.find({ path: '/mc1_emp', grant: Page.GRANT_RESTRICTED });
        expectAllToBeTruthy([page1AF, page2AF, newPage]);
        expect(countAF).toBe(2);

      });
    });
    describe('Creating a page under a page with grant RESTRICTED', () => {
      test('will create a new empty page with the same path as the grant RESTRECTED page and become a parent', async() => {
        const page1 = await Page.findOne({ path: '/mc3_awl', grant: Page.GRANT_RESTRICTED });
        const count = await Page.count({ path: '/mc3_awl' });
        expectAllToBeTruthy([page1]);
        expect(count).toBe(1);

        await Page.create('/mc3_awl/mc4_pub', 'new body', dummyUser1, { grant: Page.GRANT_PUBLIC });

        // AF => After Create
        const page1AF = await Page.findOne({ path: '/mc3_awl', grant: Page.GRANT_RESTRICTED });
        const countAF = await Page.count({ path: '/mc3_awl' });

        const newPage = await Page.findOne({ path: '/mc3_awl/mc4_pub', grant: Page.GRANT_PUBLIC });
        const newPageParent = await Page.findOne({ path: '/mc3_awl', grant: Page.GRANT_PUBLIC, isEmpty: true });
        expectAllToBeTruthy([page1AF, newPageParent, newPage]);
        expect(countAF).toBe(2);

        expect(newPage.parent).toStrictEqual(newPageParent._id);
        expect(newPageParent.parent).toStrictEqual(rootPage._id);
      });
    });

  });

  describe('update', () => {

    describe('Changing grant from PUBLIC to RESTRICTED of', () => {
      test('an only-child page will delete its empty parent page', async() => {
        const page1 = await Page.findOne({ path: '/mup1_empty', isEmpty: true });
        const page2 = await Page.findOne({ path: '/mup1_empty/mup2_public' });
        const options = { grant: 2, grantUserGroupId: null };
        expectAllToBeTruthy([page1, page2]);

        await Page.updatePage(page2, 'newRevisionBody', 'oldRevisionBody', dummyUser1, options);
        // AU => After Update
        const page1AU = await Page.findOne({ path: '/mup1_empty', isEmpty: true });
        const page2AU = await Page.findOne({ path: '/mup1_empty/mup2_public' });

        expect(page2AU).toBeTruthy();
        expect(page1AU).toBeNull();
      });
      test('a page that has children will create an empty page with the same path and it becomes a new parent', async() => {
        const page1 = await Page.findOne({ path: '/mup6_public', grant: Page.GRANT_PUBLIC });
        const page2 = await Page.findOne({ path: '/mup6_public/mup7_public', grant: Page.GRANT_PUBLIC });
        const count = await Page.count({ path: '/mup6_public' });
        const options = { grant: 2, grantUserGroupId: null };
        expectAllToBeTruthy([page1, page2]);
        expect(count).toBe(1);

        await Page.updatePage(page1, 'newRevisionBody', 'oldRevisionBody', dummyUser1, options);

        // AU => After Update
        const page1AF = await Page.findOne({ path: '/mup6_public', grant: Page.GRANT_RESTRICTED });
        const page2AF = await Page.findOne({ path: '/mup6_public/mup7_public', grant: Page.GRANT_PUBLIC });
        const newlyCreatedPage = await Page.findOne({ path: '/mup6_public', grant: Page.GRANT_PUBLIC, isEmpty: true });
        const countAF = await Page.count({ path: '/mup6_public' });
        expectAllToBeTruthy([page1AF, page2AF, newlyCreatedPage]);
        expect(countAF).toBe(2);

        expect(page1AF.parent).toBeNull();
        expect(page2AF.parent).toStrictEqual(newlyCreatedPage._id);

      });
      test('of a leaf page will NOT have empty page with the same path', async() => {});
    });
    describe('Changing grant from RESTRICTED to PUBLIC of', () => {
      test('a page with no ancestors will create ancestors with isEmpty: true', async() => {});
      test('a page will replace an empty page with the same path if any', async() => {});
    });


  });
});
