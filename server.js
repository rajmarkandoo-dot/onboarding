const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const TEAM_BOARD_ID = 18408762899;
const ONBOARDING_BOARD_ID = 18408847153;

const LOCAL_PROFILE_IMAGES = {
  raj: '/images/Raj.jpeg'
};

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function findColumn(columns, aliases) {
  const normalizedAliases = aliases.map(normalize);
  return columns.find((col) => normalizedAliases.includes(normalize(col.title)));
}

function findColumnByContains(columns, fragments) {
  const normalizedFragments = fragments.map(normalize).filter(Boolean);
  return columns.find((col) => {
    const title = normalize(col.title);
    return normalizedFragments.every((fragment) => title.includes(fragment));
  });
}

function resolveStep2Columns(columns) {
  return {
    launchDateColumn:
      findColumn(columns, ['Launch date', 'Launch Date']) ||
      findColumnByContains(columns, ['launch', 'date']),
    spendPerHeadColumn:
      findColumn(columns, ['Spend per head', 'Spend Per Head']) ||
      findColumnByContains(columns, ['spend', 'head']) ||
      findColumnByContains(columns, ['spend']),
    posColumn:
      findColumn(columns, ['POS', 'POS system']) ||
      findColumnByContains(columns, ['pos']) ||
      findColumnByContains(columns, ['point', 'sale']),
    reservationColumn:
      findColumn(columns, ['Reservation System', 'Reservation syst']) ||
      findColumnByContains(columns, ['reservation', 'system']) ||
      findColumnByContains(columns, ['reservation']),
    prepaymentsColumn:
      findColumn(columns, ['PrePayments', 'PrePayments / Card Holds']) ||
      findColumnByContains(columns, ['prepayment']) ||
      findColumnByContains(columns, ['card', 'hold']) ||
      findColumnByContains(columns, ['payment']),
    ipadColumn:
      findColumn(columns, ['iPad', 'iPads available', 'iPads']) ||
      findColumnByContains(columns, ['ipad']) ||
      findColumnByContains(columns, ['apple', 'device']),
    smsColumn:
      findColumn(columns, ['SMS', 'SMS required', 'Sms']) ||
      findColumnByContains(columns, ['sms']) ||
      findColumnByContains(columns, ['text', 'message']),
    textColumn:
      findColumn(columns, ['Text']) ||
      findColumnByContains(columns, ['notes']) ||
      findColumnByContains(columns, ['details']),
    otherIntegrationsColumn:
      findColumn(columns, ['Other Integrations', 'Other integrations / book channels required']) ||
      findColumnByContains(columns, ['other', 'integration']) ||
      findColumnByContains(columns, ['book', 'channel']) ||
      findColumnByContains(columns, ['integration'])
  };
}


function getStep3SectionColumnAliases() {
  return {
    'Venue Configuration': ['Venue Configuration', 'Venue Config', 'Venue Configura...'],
    'Marketing Configuration': ['Marketing Configuration', 'Marketing'],
    'IT Setup': ['IT Setup', 'IT'],
    'Data Imports': ['Data Imports', 'Data'],
    'Go Live': ['Go Live'],
    'Add-ons': ['Add-ons', 'Add ons', 'Addons']
  };
}

function escapeColumnValues(valueObj) {
  return JSON.stringify(valueObj)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}


function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractNotesBlock(notes, label, nextLabels = []) {
  if (!notes) return '';

  const lookahead = nextLabels.length
    ? `(?=\n\n(?:${nextLabels.map((next) => escapeRegex(next)).join('|')}):|$)`
    : '$';

  const pattern = new RegExp(`${escapeRegex(label)}:\n([\s\S]*?)${lookahead}`, 'i');
  const match = notes.match(pattern);
  return match?.[1]?.trim() || '';
}

function extractInlineValue(text, label) {
  if (!text) return '';
  const pattern = new RegExp(`${escapeRegex(label)}:\s*([^\n|]+)`, 'i');
  return text.match(pattern)?.[1]?.trim() || '';
}

function extractLineValue(text, label) {
  if (!text) return '';
  const pattern = new RegExp(`${escapeRegex(label)}:\s*([^\n]+)`, 'i');
  return text.match(pattern)?.[1]?.trim() || '';
}
async function mondayRequest(query) {
  const token = process.env.MONDAY_API_TOKEN;

  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN');
  }

  const response = await globalThis.fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token
    },
    body: JSON.stringify({ query })
  });

  const result = await response.json();

  if (!response.ok || result.errors) {
    throw new Error(JSON.stringify(result.errors || result, null, 2));
  }

  return result;
}

app.get('/onboarders', async (req, res) => {
  const region = String(req.query.region || '').trim();

  if (!region) {
    return res.status(400).json({ error: 'Missing region' });
  }

  const query = `
    query {
      boards(ids: ${TEAM_BOARD_ID}) {
        columns {
          id
          title
        }
        items_page(limit: 500) {
          items {
            name
            column_values {
              id
              text
            }
          }
        }
      }
    }
  `;

  try {
    const result = await mondayRequest(query);
    const board = result.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Team board not found' });
    }

    const regionColumn = findColumn(board.columns, ['Region']);

    if (!regionColumn) {
      return res.status(500).json({
        error: 'Region column not found on Team board',
        columns: board.columns.map((col) => ({ id: col.id, title: col.title }))
      });
    }

    const onboarders = (board.items_page?.items || [])
      .filter((item) =>
        item.column_values.some(
          (col) => col.id === regionColumn.id && normalize(col.text) === normalize(region)
        )
      )
      .map((item) => item.name)
      .filter(Boolean);

    res.json({ onboarders });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load onboarders' });
  }
});

app.post('/save-intake', async (req, res) => {
  const {
    region,
    onboarder,
    venueName,
    clientName,
    clientEmail,
    salesforceCaseNumber
  } = req.body || {};

  if (!region || !onboarder || !venueName || !clientName || !clientEmail) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const boardQuery = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          groups {
            id
            title
          }
          columns {
            id
            title
            type
          }
        }
      }
    `;

    const boardResult = await mondayRequest(boardQuery);
    const board = boardResult.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Onboarding board not found' });
    }

    const groupId = board.groups?.[0]?.id;
    if (!groupId) {
      return res.status(500).json({ error: 'No group found on onboarding board' });
    }

    const createQuery = `
      mutation {
        create_item(
          board_id: ${ONBOARDING_BOARD_ID},
          group_id: "${groupId}",
          item_name: ${JSON.stringify(venueName)}
        ) {
          id
        }
      }
    `;

    const createResult = await mondayRequest(createQuery);
    const itemId = createResult.data?.create_item?.id;

    if (!itemId) {
      return res.status(500).json({ error: 'Failed to create item' });
    }

    const venueColumn = findColumn(board.columns, ['Venue name']);
    const regionColumn = findColumn(board.columns, ['Region']);
    const onboarderColumn = findColumn(board.columns, ['Onboarder']);
    const clientNameColumn = findColumn(board.columns, ['Client name']);
    const clientEmailColumn = findColumn(board.columns, ['Client email']);
    const salesforceCaseColumn =
      findColumn(board.columns, ['Salesforce Case Number', 'Salesforce Case ID', 'SF Case Number', 'Case Number', 'Case ID']) ||
      findColumnByContains(board.columns, ['salesforce', 'case']) ||
      findColumnByContains(board.columns, ['case', 'number']) ||
      findColumnByContains(board.columns, ['case', 'id']);

    const columnValues = {};
    if (venueColumn) columnValues[venueColumn.id] = venueName;
    if (regionColumn) columnValues[regionColumn.id] = region;
    if (onboarderColumn) columnValues[onboarderColumn.id] = onboarder;
    if (clientNameColumn) columnValues[clientNameColumn.id] = clientName;
    if (clientEmailColumn) columnValues[clientEmailColumn.id] = clientEmail;
    if (salesforceCaseColumn && salesforceCaseNumber) columnValues[salesforceCaseColumn.id] = salesforceCaseNumber;

    const updateQuery = `
      mutation {
        change_multiple_column_values(
          board_id: ${ONBOARDING_BOARD_ID},
          item_id: ${itemId},
          column_values: "${escapeColumnValues(columnValues)}"
        ) {
          id
        }
      }
    `;

    const updateResult = await mondayRequest(updateQuery);

    res.json({
      ok: true,
      itemId,
      created: createResult.data,
      updated: updateResult.data
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save intake to Monday' });
  }
});

function findAccessLinkColumn(columns, mode) {
  if (mode === 'internal') {
    return (
      findColumn(columns, [
        'Internal link',
        'Internal Link',
        'OB Link',
        'OB link',
        'Edit Link',
        'Edit URL',
        'Internal URL'
      ]) ||
      findColumnByContains(columns, ['internal', 'link']) ||
      findColumnByContains(columns, ['ob', 'link']) ||
      findColumnByContains(columns, ['edit', 'link']) ||
      findColumnByContains(columns, ['internal', 'url'])
    );
  }

  return (
    findColumn(columns, [
      'Invite link',
      'Invite Link',
      'Client Invite Link',
      'Client link',
      'Invite URL',
      'Client URL'
    ]) ||
    findColumnByContains(columns, ['invite']) ||
    findColumnByContains(columns, ['client', 'link']) ||
    findColumnByContains(columns, ['invite', 'url']) ||
    findColumnByContains(columns, ['client', 'url'])
  );
}

app.post('/save-invite-link', async (req, res) => {
  const { itemId, inviteUrl } = req.body || {};

  if (!itemId || !inviteUrl) {
    return res.status(400).json({ error: 'Missing itemId or inviteUrl' });
  }

  try {
    const boardQuery = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          columns {
            id
            title
            type
          }
        }
      }
    `;

    const boardResult = await mondayRequest(boardQuery);
    const board = boardResult.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Onboarding board not found' });
    }

    const inviteColumn = findAccessLinkColumn(board.columns, 'invite');

    if (!inviteColumn) {
      return res.status(404).json({
        error: 'Invite link column not found',
        columns: board.columns.map((col) => ({ id: col.id, title: col.title, type: col.type }))
      });
    }

    const columnValues = {
      [inviteColumn.id]: inviteColumn.type === 'link'
        ? { url: inviteUrl, text: 'Open invite' }
        : inviteUrl
    };

    const mutation = `
      mutation {
        change_multiple_column_values(
          board_id: ${ONBOARDING_BOARD_ID},
          item_id: ${itemId},
          column_values: "${escapeColumnValues(columnValues)}"
        ) {
          id
        }
      }
    `;

    const result = await mondayRequest(mutation);

    res.json({
      ok: true,
      itemId,
      inviteUrl,
      columnId: inviteColumn.id,
      columnTitle: inviteColumn.title,
      updated: result.data
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to save invite link' });
  }
});

app.post('/save-internal-link', async (req, res) => {
  const { itemId, internalUrl } = req.body || {};

  if (!itemId || !internalUrl) {
    return res.status(400).json({ error: 'Missing itemId or internalUrl' });
  }

  try {
    const boardQuery = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          columns {
            id
            title
            type
          }
        }
      }
    `;

    const boardResult = await mondayRequest(boardQuery);
    const board = boardResult.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Onboarding board not found' });
    }

    const internalColumn = findAccessLinkColumn(board.columns, 'internal');

    if (!internalColumn) {
      return res.status(404).json({
        error: 'Internal link column not found',
        columns: board.columns.map((col) => ({ id: col.id, title: col.title, type: col.type }))
      });
    }

    const columnValues = {
      [internalColumn.id]: internalColumn.type === 'link'
        ? { url: internalUrl, text: 'Open internal edit' }
        : internalUrl
    };

    const mutation = `
      mutation {
        change_multiple_column_values(
          board_id: ${ONBOARDING_BOARD_ID},
          item_id: ${itemId},
          column_values: "${escapeColumnValues(columnValues)}"
        ) {
          id
        }
      }
    `;

    const result = await mondayRequest(mutation);

    res.json({
      ok: true,
      itemId,
      internalUrl,
      columnId: internalColumn.id,
      columnTitle: internalColumn.title,
      updated: result.data
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to save internal link' });
  }
});

app.post('/update-step2', async (req, res) => {
  const {
    itemId,
    launchDate,
    spendPerHead,
    posSystem,
    reservationSystem,
    prepayments,
    prepaymentType,
    cancellationPeriod,
    chargeModel,
    localCurrencyAmount,
    iPads,
    smsRequired,
    companyName,
    businessName,
    businessRegistrationNumber,
    businessWebsite,
    businessAddress,
    repFirstName,
    repLastName,
    repPhone,
    repEmail,
    otherIntegrations
  } = req.body || {};

  if (!itemId) {
    return res.status(400).json({ error: 'Missing itemId' });
  }

  try {
    const boardQuery = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          columns {
            id
            title
            type
          }
        }
      }
    `;

    const boardResult = await mondayRequest(boardQuery);
    const board = boardResult.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Onboarding board not found' });
    }

    const {
      launchDateColumn,
      spendPerHeadColumn,
      posColumn,
      reservationColumn,
      prepaymentsColumn,
      ipadColumn,
      smsColumn,
      textColumn,
      otherIntegrationsColumn
    } = resolveStep2Columns(board.columns);

    const prepaymentsSummary = prepayments === 'Yes'
      ? [
          'Yes',
          prepaymentType ? `Type: ${prepaymentType}` : null,
          cancellationPeriod ? `Cancellation period: ${cancellationPeriod}` : null,
          chargeModel ? `Charge model: ${chargeModel}` : null,
          localCurrencyAmount ? `Amount: ${localCurrencyAmount}` : null
        ].filter(Boolean).join(' | ')
      : 'No';

    const smsSummary = smsRequired === 'Yes'
      ? [
          'SMS required: Yes',
          companyName ? `Company name: ${companyName}` : null,
          businessName ? `Business Name: ${businessName}` : null,
          businessRegistrationNumber ? `Business Registration Number: ${businessRegistrationNumber}` : null,
          businessWebsite ? `Business Website: ${businessWebsite}` : null,
          businessAddress ? `Business Address: ${businessAddress}` : null,
          repFirstName ? `Authorized Representative First Name: ${repFirstName}` : null,
          repLastName ? `Authorized Representative Last Name: ${repLastName}` : null,
          repPhone ? `Authorized Representative Phone Number: ${repPhone}` : null,
          repEmail ? `Authorized Representative Email Address: ${repEmail}` : null
        ].filter(Boolean).join('\n')
      : 'No';

    const notes = [
      launchDate ? `Launch date: ${launchDate}` : null,
      prepayments === 'Yes' ? `PrePayments details:\n${prepaymentsSummary}` : null,
      smsRequired === 'Yes' ? `SMS details:\n${smsSummary}` : null
    ].filter(Boolean).join('\n\n');

    const columnValues = {};
    if (launchDateColumn && launchDate) {
      columnValues[launchDateColumn.id] = launchDateColumn.type === 'date' ? { date: launchDate } : launchDate;
    }
    if (spendPerHeadColumn && spendPerHead) columnValues[spendPerHeadColumn.id] = spendPerHead;
    if (posColumn && posSystem) columnValues[posColumn.id] = posSystem;
    if (reservationColumn && reservationSystem) columnValues[reservationColumn.id] = reservationSystem;
    if (prepaymentsColumn && prepaymentsSummary) columnValues[prepaymentsColumn.id] = prepaymentsSummary;
    if (ipadColumn && iPads) columnValues[ipadColumn.id] = iPads;
    if (smsColumn && smsRequired) columnValues[smsColumn.id] = smsRequired;
    if (textColumn && notes) columnValues[textColumn.id] = notes;
    if (otherIntegrationsColumn && otherIntegrations) columnValues[otherIntegrationsColumn.id] = otherIntegrations;

    const updateQuery = `
      mutation {
        change_multiple_column_values(
          board_id: ${ONBOARDING_BOARD_ID},
          item_id: ${itemId},
          column_values: "${escapeColumnValues(columnValues)}"
        ) {
          id
        }
      }
    `;

    const result = await mondayRequest(updateQuery);

    res.json({
      ok: true,
      updated: result.data
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to update step 2' });
  }
});


app.get('/onboarding-item', async (req, res) => {
  const itemId = String(req.query.itemId || '').trim();

  if (!itemId) {
    return res.status(400).json({ error: 'Missing itemId' });
  }

  try {
    const query = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          columns {
            id
            title
            type
          }
        }
        items(ids: [${itemId}]) {
          id
          name
          column_values {
            id
            text
            type
            value
          }
        }
      }
    `;

    const result = await mondayRequest(query);
    const board = result.data?.boards?.[0];
    const item = result.data?.items?.[0];

    if (!board || !item) {
      return res.status(404).json({ error: 'Onboarding item not found' });
    }

    const getText = (aliases, containsFragments = []) => {
      const column =
        findColumn(board.columns, aliases) ||
        (containsFragments.length ? findColumnByContains(board.columns, containsFragments) : null);
      if (!column) return '';
      return item.column_values.find((value) => value.id === column.id)?.text?.trim() || '';
    };

    const getValue = (aliases, containsFragments = []) => {
      const column =
        findColumn(board.columns, aliases) ||
        (containsFragments.length ? findColumnByContains(board.columns, containsFragments) : null);
      if (!column) return null;
      const raw = item.column_values.find((value) => value.id === column.id)?.value;
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (error) {
        return null;
      }
    };

    const step2Columns = resolveStep2Columns(board.columns);
    const getTextByColumn = (column) => {
      if (!column) return '';
      return item.column_values.find((value) => value.id === column.id)?.text?.trim() || '';
    };

    const notes = getTextByColumn(step2Columns.textColumn);
    const prepaymentsText = getTextByColumn(step2Columns.prepaymentsColumn);
    const smsText = getTextByColumn(step2Columns.smsColumn);
    const prepaymentsBlock = extractNotesBlock(notes, 'PrePayments details', ['SMS details']);
    const smsBlock = extractNotesBlock(notes, 'SMS details');
    const launchDateValue = getValue(['Launch date', 'Launch Date'], ['launch', 'date']);
    const launchDateText = getText(['Launch date', 'Launch Date'], ['launch', 'date']) || extractLineValue(notes, 'Launch date');

    const step3Statuses = Object.entries(getStep3SectionColumnAliases()).reduce((acc, [sectionName, aliases]) => {
      acc[sectionName] = getText(aliases);
      return acc;
    }, {});

    const payload = {
      itemId: item.id,
      venueName: item.name || '',
      region: getText(['Region']),
      onboarder: getText(['Onboarder']),
      clientName: getText(['Client name']),
      clientEmail: getText(['Client email']),
      salesforceCaseNumber: getText(['Salesforce Case Number', 'Salesforce Case ID', 'SF Case Number', 'Case Number', 'Case ID'], ['case']),
      launchDate: launchDateValue?.date || launchDateText || '',
      spendPerHead: getText(['Spend per head', 'Spend Per Head'], ['spend']),
      additionalUsersText: extractNotesBlock(notes, 'Additional users', ['PrePayments details', 'SMS details']),
      posSystem: getText(['POS', 'POS system'], ['pos']),
      reservationSystem: getText(['Reservation System', 'Reservation syst'], ['reservation']),
      prepayments: /^yes/i.test(prepaymentsText || prepaymentsBlock) ? 'Yes' : (/^no/i.test(prepaymentsText || prepaymentsBlock) ? 'No' : ''),
      prepaymentType: extractInlineValue(prepaymentsBlock || prepaymentsText, 'Type'),
      cancellationPeriod: extractInlineValue(prepaymentsBlock || prepaymentsText, 'Cancellation period'),
      chargeModel: extractInlineValue(prepaymentsBlock || prepaymentsText, 'Charge model'),
      localCurrencyAmount: extractInlineValue(prepaymentsBlock || prepaymentsText, 'Amount'),
      iPads: getText(['iPad', 'iPads available', 'iPads'], ['ipad']),
      smsRequired: /^yes/i.test(smsText) ? 'Yes' : (/^no/i.test(smsText) ? 'No' : ''),
      companyName: extractLineValue(smsBlock, 'Company name'),
      businessName: extractLineValue(smsBlock, 'Business Name'),
      businessRegistrationNumber: extractLineValue(smsBlock, 'Business Registration Number'),
      businessWebsite: extractLineValue(smsBlock, 'Business Website'),
      businessAddress: extractLineValue(smsBlock, 'Business Address'),
      repFirstName: extractLineValue(smsBlock, 'Authorized Representative First Name'),
      repLastName: extractLineValue(smsBlock, 'Authorized Representative Last Name'),
      repPhone: extractLineValue(smsBlock, 'Authorized Representative Phone Number'),
      repEmail: extractLineValue(smsBlock, 'Authorized Representative Email Address'),
      otherIntegrations: getText(['Other Integrations', 'Other integrations / book channels required'], ['integration']),
      step3Statuses
    };

    res.json({ ok: true, item: payload });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to load onboarding item' });
  }
});


app.post('/update-step3', async (req, res) => {
  const {
    itemId,
    section,
    completed
  } = req.body || {};

  if (!itemId || !section) {
    return res.status(400).json({ error: 'Missing itemId or section' });
  }

  try {
    const boardQuery = `
      query {
        boards(ids: ${ONBOARDING_BOARD_ID}) {
          columns {
            id
            title
            type
          }
        }
      }
    `;

    const boardResult = await mondayRequest(boardQuery);
    const board = boardResult.data?.boards?.[0];

    if (!board) {
      return res.status(500).json({ error: 'Onboarding board not found' });
    }

    const sectionColumnAliases = getStep3SectionColumnAliases();

    const aliases = sectionColumnAliases[section];

    if (!aliases) {
      return res.status(400).json({ error: 'Unknown Step 3 section' });
    }

    const statusColumn = findColumn(board.columns, aliases);

    if (!statusColumn) {
      return res.status(404).json({
        error: 'Matching Step 3 status column not found',
        section,
        lookedFor: aliases,
        columns: board.columns.map((col) => ({ id: col.id, title: col.title, type: col.type }))
      });
    }

    const statusLabel = completed ? 'Complete' : 'Not Started';
    const mutation = `
      mutation {
        change_simple_column_value(
          board_id: ${ONBOARDING_BOARD_ID},
          item_id: ${itemId},
          column_id: "${statusColumn.id}",
          value: ${JSON.stringify(statusLabel)}
        ) {
          id
        }
      }
    `;

    const result = await mondayRequest(mutation);

    res.json({
      ok: true,
      itemId,
      section,
      statusLabel,
      columnId: statusColumn.id,
      columnTitle: statusColumn.title,
      updated: result.data
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to update step 3 status' });
  }
});

app.get('/monday-team-profile', async (req, res) => {
  const boardId = Number(req.query.boardId || TEAM_BOARD_ID);
  const name = String(req.query.name || '').trim();

  if (!name) {
    return res.status(400).json({ error: 'Missing name' });
  }

  const query = `
    query {
      boards(ids: ${boardId}) {
        columns {
          id
          title
          type
        }
        items_page(limit: 500) {
          items {
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  try {
    const result = await mondayRequest(query);
    const board = result.data?.boards?.[0];

    if (!board) {
      return res.status(404).json({ error: 'Board not found' });
    }

    const item = (board.items_page?.items || []).find(
      (entry) => normalize(entry.name) === normalize(name)
    );

    if (!item) {
      return res.status(404).json({ error: 'Onboarder not found' });
    }

    const emailColumn = findColumn(board.columns, ['Email', 'E-mail']);

    const getColumnValue = (columnId) =>
      item.column_values.find((col) => col.id === columnId);

    const email = emailColumn ? getColumnValue(emailColumn.id)?.text || '' : '';
    const photoUrl = LOCAL_PROFILE_IMAGES[normalize(item.name)] || '';

    res.json({
      name: item.name || '',
      email,
      photoUrl
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load team profile' });
  }
});

app.get('/monday-resource-link', async (req, res) => {
  const boardId = Number(req.query.boardId || TEAM_BOARD_ID);
  const value = String(req.query.value || '').trim();
  const type = String(req.query.type || '').trim().toLowerCase();

  if (!value) {
    return res.status(400).json({ error: 'Missing value' });
  }

  const query = `
    query {
      boards(ids: ${boardId}) {
        columns {
          id
          title
        }
        items_page(limit: 500) {
          items {
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  try {
    const result = await mondayRequest(query);
    const board = result.data?.boards?.[0];
    const items = board?.items_page?.items || [];

    const match = items.find((item) => normalize(item.name) === normalize(value));

    if (!match) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    const linkColumn = findColumn(board.columns || [], ['Link']);
    const linkValue = linkColumn
      ? match.column_values.find((col) => col.id === linkColumn.id)
      : null;

    let url = '';

    try {
      const parsed = linkValue?.value ? JSON.parse(linkValue.value) : null;
      url = parsed?.url || '';
    } catch {
      url = '';
    }

    if (!url && linkValue?.text && /^https?:\/\//i.test(linkValue.text)) {
      url = linkValue.text;
    }

    if (!url) {
      return res.status(404).json({ error: 'Link not found for resource' });
    }

    const labelPrefixes = {
      reservation: 'Reservation',
      payment: 'Payment',
      integration: 'Integration',
      pos: 'POS'
    };
    const labelPrefix = labelPrefixes[type] || 'Resource';

    res.json({
      url,
      label: `${labelPrefix} resource: ${match.name}`
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load resource link' });
  }
});

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
