// update-status.js

// This script updates a Monday.com task to "Done"

const BOARD_ID = 18408762899;
const ITEM_ID = 11754860756;
const STATUS_COLUMN_ID = 'status'; // change if needed

async function updateTask() {
  const API_TOKEN = process.env.MONDAY_API_TOKEN;

  if (!API_TOKEN) {
    console.error('❌ Missing MONDAY_API_TOKEN');
    return;
  }

  const query = `
    mutation {
      change_column_value(
        board_id: ${BOARD_ID},
        item_id: ${ITEM_ID},
        column_id: "${STATUS_COLUMN_ID}",
        value: "{\\"label\\":\\"Done\\"}"
      ) {
        id
      }
    }
  `;

  try {
    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': API_TOKEN
      },
      body: JSON.stringify({ query })
    });

    const data = await response.json();

    if (data.errors) {
      console.error('❌ Monday API error:');
      console.error(JSON.stringify(data, null, 2));
    } else {
      console.log('✅ Task updated successfully!');
      console.log(data);
    }

  } catch (error) {
    console.error('❌ Network error:', error);
  }
}

updateTask();