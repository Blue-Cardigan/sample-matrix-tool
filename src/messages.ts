import { v4 as uuidv4 } from "uuid";
import { sendMessage, getEvent, getRoomMembers, getProfile, createDirectMessageRoom, redactEvent } from "./matrixClientRequests";
import { PERSON_NAME, ROLE_NAME, PSEUDO_STATE_EVENT_TYPE } from "./constants";
import { getPseudoState, setPseudoState } from "./pseudoState";
import OpenAI from 'openai';

const { userId } = process.env;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let assistant: OpenAI.Beta.Assistants.Assistant;

const initializeAssistant = async () => {
  assistant = await openai.beta.assistants.create({
    name: "Matrix Tool Assistant",
    instructions: `You are an assistant bot that manages a Matrix chat room. Based on the message you receive, you will either assign roles or send a reply to the room.

    Be concise, witty, and critical of the Singaporean government.

    ###Role Management###
    You will be provided with a list of room members and their user IDs at the start of each conversation.
    When assigning roles, make sure to use the exact display name as provided in the room members list.
    If a requested name doesn't match any room member exactly, try to find the closest match and confirm with the user.
    If the user asks for a role that is already assigned, let them know.`,
    model: "gpt-4o-mini",
    tools: [{
      type: "function",
      function: {
        name: "assignRole",
        description: "Assign a role to a person in the chat",
        parameters: {
          type: "object",
          properties: {
            personName: {
              type: "string",
              description: "Display name of the person to assign the role to (must match exactly)"
            },
            roleName: {
              type: "string",
              description: "Name of the role to assign"
            }
          },
          required: ["personName", "roleName"]
        }
      }
    }]
  });
};

// Initialize the assistant when the module loads
initializeAssistant().catch(console.error);

// const sendPersonRequest = (roomId: string, replyText: string) => {
//   sendMessage(
//     roomId,
//     `Quote-reply to this message with the name of the role you want to assign to ${replyText}.`,
//     {
//       person: {
//         name: replyText,
//       },
//       expecting: ROLE_NAME,
//     }
//   );
// };

const assignRole = async (
  personName: string,
  roomId: string,
  replyText: string
) => {
  let roleState = await getPseudoState(roomId, PSEUDO_STATE_EVENT_TYPE);

  if (!roleState) {
    roleState = {
      content: {
        assignedRoles: [],
      },
    };
  }

  const { assignedRoles } = roleState.content;
  assignedRoles.push({
    id: uuidv4(),
    person: {
      name: personName,
    },
    role: {
      name: replyText,
    },
  });

  setPseudoState(roomId, PSEUDO_STATE_EVENT_TYPE, { assignedRoles });

  // sendMessage(roomId, `You've assigned ${personName} the role ${replyText}.`);
};

const handleReply = async (event) => {
  const roomId = event.event.room_id;
  const message = event.event.content.body;
  const replyText = message.split("\n\n")[1] || message;
  const prevEventId =
    event.event.content["m.relates_to"]["m.in_reply_to"].event_id;

  const prevEvent = (await getEvent(roomId, prevEventId)) as any;

  if (prevEvent.sender !== userId) return;

  const { expecting } = prevEvent.content.context;

  // if (expecting === PERSON_NAME) {
  //   sendPersonRequest(roomId, replyText);
  // }
  if (expecting === ROLE_NAME) {
    const personName = prevEvent.content.context.person.name;
    assignRole(personName, roomId, replyText);
  }
};

// Add new helper function to get member information
const getRoomMemberInfo = async (roomId: string) => {
  const membersResponse = await getRoomMembers(roomId);
  const membersData = (await membersResponse.json()) as any;
  
  // Get profile info for each member
  const memberProfiles = await Promise.all(
    membersData.chunk.map(async (member: { user_id: string }) => {
      const profileResponse = await getProfile(member.user_id);
      const profile = await profileResponse.json();
      console.log(`profile: ${JSON.stringify(profile)}`);
      return {
        userId: member.user_id,
        displayName: profile || member.user_id
      };
    })
  );
  
  return memberProfiles;
};

const handleAssistantMessage = async (roomId: string, message: string) => {
  const memberInfo = await getRoomMemberInfo(roomId);
  console.log(`member info: ${JSON.stringify(memberInfo)}`);
  
  const thread = await openai.beta.threads.create();
  
  // Send both the user's message and the room context
  await openai.beta.threads.messages.create(thread.id, {
    role: "user",
    content: `Room members: ${memberInfo.map(m => `${m.displayName} (${m.userId})`).join(', ')}\n\nUser message: ${message}`
  });

  const run = await openai.beta.threads.runs.create(thread.id, {
    assistant_id: assistant.id
  });

  // Poll for completion
  let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
  while (runStatus.status !== 'completed' && runStatus.status !== 'failed') {
    await new Promise(resolve => setTimeout(resolve, 1000));
    runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    
    if (runStatus.status === 'requires_action') {
      const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
      const toolOutputs = [];

      for (const toolCall of toolCalls) {
        if (toolCall.function.name === 'assignRole') {
          const args = JSON.parse(toolCall.function.arguments);
          await assignRole(args.personName, roomId, args.roleName);
          toolOutputs.push({
            tool_call_id: toolCall.id,
            output: `Assigned ${args.personName} the role ${args.roleName}`
          });
        }
      }

      await openai.beta.threads.runs.submitToolOutputs(thread.id, run.id, {
        tool_outputs: toolOutputs
      });
    }
  }

  // Get assistant's response
  const messages = await openai.beta.threads.messages.list(thread.id);
  console.log(`messages: ${JSON.stringify(messages)}`);
  const assistantMessage = messages.data[0].content[0];
  if ('text' in assistantMessage) {
    sendMessage(roomId, assistantMessage.text.value);
  }
};

const messageEveryMember = async (roomId: string, message: string, sender: string) => {
  try {
    // Get all room members
    const membersResponse = await getRoomMembers(roomId);
    const membersData = (await membersResponse.json()) as any;
    
    // Track which members we've messaged to avoid duplicates
    const messagedMembers = new Set<string>();
    
    // Filter out the bot and the sender
    const members = membersData.chunk.filter(
      (member: { user_id: string, membership: string }) => 
        member.user_id !== userId && 
        member.user_id !== sender &&
        member.membership === 'join' // Only message current members
    );

    // Create a DM room with each member and send the message
    for (const member of members) {
      try {
        // Skip if we've already messaged this member
        if (messagedMembers.has(member.user_id)) {
          continue;
        }
        
        // Create new DM room
        const dmRoomId = await createDirectMessageRoom(sender, member.user_id);
        
        // Send the message in the new room
        await sendMessage(
          dmRoomId, 
          `${message}`
        );
        
        // Mark this member as messaged
        messagedMembers.add(member.user_id);
      } catch (error) {
        console.error(`Failed to message ${member.user_id}:`, error);
      }
    }

    // Confirm in the original room that messages were sent
    await sendMessage(
      roomId, 
      `Created ${messagedMembers.size} direct message rooms and sent: "${message}"`
    );

  } catch (error) {
    console.error('Error messaging members:', error);
    await sendMessage(roomId, 'Error occurred while messaging members.');
  }
};

// Simple list of offensive terms - in production, you might want to use a more sophisticated solution
const OFFENSIVE_TERMS = [
  'ur mom gay',
  'aha lol',
  // Add more terms as needed
];

const containsOffensiveContent = (message: string): boolean => {
  const lowerMessage = message.toLowerCase();
  return OFFENSIVE_TERMS.some(term => lowerMessage.includes(term.toLowerCase()));
};

const handleMessage = async (event) => {
  const message = event.event.content.body;
  const { room_id, event_id, sender } = event.event;

  // Check for offensive content first
  if (containsOffensiveContent(message)) {
    try {
      await redactEvent(
        room_id,
        event_id,
        "Message contained inappropriate content"
      );
      
      // Notify about the redaction
      await sendMessage(
        room_id,
        `A message from ${sender} was redacted due to inappropriate content.`
      );
      return;
    } catch (error) {
      console.error('Failed to redact message:', error);
    }
  }

  // Continue with existing message handling
  if (message.toLowerCase().startsWith("!messageeveryone")) {
    const messageContent = message.slice("!messageeveryone".length).trim();
    if (messageContent) {
      await messageEveryMember(room_id, messageContent, sender);
    } else {
      await sendMessage(room_id, "Please provide a message to send.");
    }
    return;
  }

  if (event.event.content["m.relates_to"]) {
    handleReply(event);
    return;
  }

  if (message.toLowerCase().startsWith("!assistant")) {
    const userMessage = message.slice("!assistant".length).trim();
    await handleAssistantMessage(room_id, userMessage);
    return;
  }
};

const WELCOME_EMOJIS = ['👋', '🎉', '✨', '🌟', '🎊', '🙌', '💫', '🤗', '🌈', '💝'];

export const handleJoin = async (event) => {
  const roomId = event.event.room_id;
  const sender = event.event.sender;
  const randomEmoji = WELCOME_EMOJIS[Math.floor(Math.random() * WELCOME_EMOJIS.length)];
  await sendMessage(roomId, `Welcome ${sender}! ${randomEmoji}`);
};

export default handleMessage;
