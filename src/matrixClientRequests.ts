const { access_token, homeserver } = process.env;

export const sendEvent = (roomId: string, content: any, type: string) => {
  return fetch(`${homeserver}/_matrix/client/v3/rooms/${roomId}/send/${type}`, {
    method: "POST",
    body: JSON.stringify(content),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`,
    },
  });
};

export const sendMessage = (roomId: string, message: string, context = {}) => {
  return sendEvent(
    roomId,
    {
      body: message,
      msgtype: "m.text",
      context,
    },
    "m.room.message"
  );
};

export const getEvent = async (roomId: string, eventId: string) => {
  const response = await fetch(
    `${homeserver}/_matrix/client/v3/rooms/${roomId}/event/${eventId}`,
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    }
  );
  return response.json();
};

export const getProfile = async (userId: string) => {
  return fetch(`${homeserver}/_matrix/client/v3/profile/${userId}`, {
    headers: {
      Authorization: `Bearer ${access_token}`,
    },
  });
};

export const getRoomMembers = async (roomId: string) => {
  return fetch(`${homeserver}/_matrix/client/v3/rooms/${roomId}/members`, {
    headers: {
      Authorization: `Bearer ${access_token}`,
    },
  });
};

export const getRoomEvents = (roomId: string) => {
  return fetch(
    `${homeserver}/_matrix/client/v3/rooms/${roomId}/messages?limit=10000&dir=b`,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
    }
  );
};

export const redactEvent = async (
  roomId: string,
  eventId: string,
  redactionReason: string
) => {
  const txn = Date.now();

  return fetch(
    `${homeserver}/_matrix/client/v3/rooms/${roomId}/redact/${eventId}/${txn}`,
    {
      method: "PUT",
      body: JSON.stringify({
        reason: redactionReason,
      }),
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    }
  );
};

interface CreateRoomResponse {
  room_id: string;
}

export const createDirectMessageRoom = async (sender: string, recipientId: string): Promise<string> => {
  const response = await fetch(`${homeserver}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${access_token}`
    },
    body: JSON.stringify({
      preset: "trusted_private_chat",
      invite: [recipientId],
      is_direct: true,
      initial_state: [
        {
          type: "m.room.name",
          content: {
            name: `DM: ${sender} & ${recipientId}`
          }
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to create room: ${response.statusText}`);
  }

  const data = await response.json() as CreateRoomResponse;
  return data.room_id;
};