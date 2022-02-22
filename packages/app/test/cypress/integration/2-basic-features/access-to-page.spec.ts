
context('Access to page', () => {
  const ssPrefix = 'access-to-page-';

  let connectSid: string | undefined;

  before(() => {
    // login
    cy.fixture("user-admin.json").then(user => {
      cy.login(user.username, user.password);
    });
    cy.getCookie('connect.sid').then(cookie => {
      connectSid = cookie?.value;
    });
  });

  beforeEach(() => {
    if (connectSid != null) {
      cy.setCookie('connect.sid', connectSid);
    }
  });

  it('/Sandbox is successfully loaded', () => {
    cy.visit('/Sandbox', {  });

    // collapse sidebar and wait saving
    cy.collapseSidebar(true);
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(1500);

    cy.screenshot(`${ssPrefix}-sandbox`, { capture: 'viewport' });
  });

  it('/Sandbox with anchor hash is successfully loaded', () => {
    cy.visit('/Sandbox#Headers');
    cy.screenshot(`${ssPrefix}-sandbox-headers`, { capture: 'viewport' });
  });

  it('/Sandbox/Math is successfully loaded', () => {
    cy.visit('/Sandbox/Math');
    cy.screenshot(`${ssPrefix}-sandbox-math`, { capture: 'viewport' });
  });

  it('/Sandbox with edit is successfully loaded', () => {
    cy.visit('/Sandbox#edit');
    cy.screenshot(`${ssPrefix}-sandbox-edit-page`, { capture: 'viewport' });
  })

  it('/user/admin is successfully loaded', () => {
    cy.visit('/user/admin', {  });
    cy.screenshot(`${ssPrefix}-user-admin`, { capture: 'viewport' });
  });

});
