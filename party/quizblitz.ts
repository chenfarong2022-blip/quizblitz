interface Question {
  id: string;
  question: string;
  options: string[];
  correctAnswer: number;
  timeLimit: number;
}

interface Player {
  id: string;
  name: string;
  score: number;
  answered: boolean;
  answerTime: number;
  correctCount: number;
  joinedAt: number;
}

interface RoomState {
  hostId: string | null;
  players: Map<string, Player>;
  questions: Question[];
  currentQuestionIndex: number;
  gameStatus: 'waiting' | 'playing' | 'finished';
  questionStartTime: number;
  canAnswer: boolean;
}

const rooms = new Map<string, RoomState>();

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function getOrCreateRoom(roomId: string): RoomState {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostId: null,
      players: new Map(),
      questions: [],
      currentQuestionIndex: -1,
      gameStatus: 'waiting',
      questionStartTime: 0,
      canAnswer: false,
    });
  }
  return rooms.get(roomId)!;
}

function broadcast(room: RoomState, message: object, excludeId?: string) {
  const msg = JSON.stringify(message);
  room.players.forEach((_, playerId) => {
    if (playerId !== excludeId) {
      const connection = (globalThis as any).connections?.get(playerId);
      if (connection) {
        connection.send(msg);
      }
    }
  });
}

function sendTo(connection: any, message: object) {
  connection.send(JSON.stringify(message));
}

export default {
  onConnect(conn: any, ctx: any) {
    const roomId = ctx.room;
    const room = getOrCreateRoom(roomId);

    conn.on('message', (message: string) => {
      try {
        const data = JSON.parse(message);
        handleMessage(conn, data, roomId, room, conn.id);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    });

    conn.on('close', () => {
      const player = room.players.get(conn.id);
      if (player) {
        room.players.delete(conn.id);
        broadcast(room, {
          type: 'player_left',
          playerId: conn.id,
          playerName: player.name,
          playerCount: room.players.size,
        });
      }
    });
  },
};

function handleMessage(conn: any, data: any, roomId: string, room: RoomState, connId: string) {
  switch (data.type) {
    case 'create_room': {
      room.hostId = connId;
      sendTo(conn, {
        type: 'room_created',
        roomCode: roomId,
        isHost: true,
      });
      break;
    }

    case 'join': {
      const name = data.name?.slice(0, 20) || `玩家${Math.floor(Math.random() * 1000)}`;
      const player: Player = {
        id: connId,
        name,
        score: 0,
        answered: false,
        answerTime: 0,
        correctCount: 0,
        joinedAt: Date.now(),
      };
      room.players.set(connId, player);

      sendTo(conn, {
        type: 'joined',
        playerId: connId,
        playerName: name,
        isHost: room.hostId === connId,
        roomCode: roomId,
        questions: room.gameStatus === 'waiting' ? [] : room.questions,
        gameStatus: room.gameStatus,
        currentQuestion: room.currentQuestionIndex >= 0 ? room.currentQuestionIndex : null,
        playerCount: room.players.size,
        players: Array.from(room.players.values()).map(p => ({
          id: p.id,
          name: p.name,
          score: p.score,
          correctCount: p.correctCount,
        })),
      });

      broadcast(room, {
        type: 'player_joined',
        playerId: connId,
        playerName: name,
        playerCount: room.players.size,
        players: Array.from(room.players.values()).map((p: Player) => ({
          id: p.id,
          name: p.name,
          score: p.score,
          correctCount: p.correctCount,
        })),
      }, connId);
      break;
    }

    case 'add_questions': {
      if (room.hostId !== connId) return;
      const questions: Question[] = data.questions || [];
      questions.forEach((q: any, i: number) => {
        room.questions.push({
          id: `q_${Date.now()}_${i}`,
          question: q.question,
          options: q.options,
          correctAnswer: q.correctAnswer,
          timeLimit: q.timeLimit || 15,
        });
      });
      sendTo(conn, {
        type: 'questions_added',
        questionCount: questions.length,
        totalQuestions: room.questions.length,
      });
      break;
    }

    case 'start_game': {
      if (room.hostId !== connId) return;
      if (room.questions.length === 0) {
        sendTo(conn, { type: 'error', message: '没有题目，请先添加题目' });
        return;
      }
      room.gameStatus = 'playing';
      room.currentQuestionIndex = -1;
      room.players.forEach(p => {
        p.score = 0;
        p.correctCount = 0;
      });
      broadcast(room, {
        type: 'game_started',
        questionCount: room.questions.length,
      });
      break;
    }

    case 'next_question': {
      if (room.hostId !== connId) return;
      if (room.gameStatus !== 'playing') return;

      room.currentQuestionIndex++;
      if (room.currentQuestionIndex >= room.questions.length) {
        room.gameStatus = 'finished';
        broadcast(room, {
          type: 'game_finished',
          rankings: getRankings(room),
        });
        return;
      }

      room.questionStartTime = Date.now();
      room.canAnswer = true;
      room.players.forEach(p => {
        p.answered = false;
        p.answerTime = 0;
      });

      const question = room.questions[room.currentQuestionIndex];
      broadcast(room, {
        type: 'question',
        index: room.currentQuestionIndex,
        question: {
          id: question.id,
          question: question.question,
          options: question.options,
          timeLimit: question.timeLimit,
        },
        totalQuestions: room.questions.length,
      });
      break;
    }

    case 'answer': {
      if (room.gameStatus !== 'playing' || !room.canAnswer) return;

      const player = room.players.get(connId);
      if (!player || player.answered) return;

      const question = room.questions[room.currentQuestionIndex];
      if (!question) return;

      const timeTaken = (Date.now() - room.questionStartTime) / 1000;
      const isCorrect = data.answer === question.correctAnswer;
      const timeBonus = Math.max(0, Math.floor((question.timeLimit - timeTaken) * 50));
      const points = isCorrect ? 1000 + timeBonus : 0;

      player.answered = true;
      player.answerTime = timeTaken;
      player.score += points;
      if (isCorrect) player.correctCount++;

      sendTo(conn, {
        type: 'answer_result',
        isCorrect,
        points,
        totalScore: player.score,
        timeTaken: Math.round(timeTaken * 100) / 100,
      });
      break;
    }

    case 'show_ranking': {
      if (room.hostId !== connId) return;
      broadcast(room, {
        type: 'ranking',
        rankings: getRankings(room),
      });
      break;
    }

    case 'stop_answer': {
      if (room.hostId !== connId) return;
      room.canAnswer = false;
      const question = room.questions[room.currentQuestionIndex];
      broadcast(room, {
        type: 'answer_closed',
        correctAnswer: question?.correctAnswer,
        rankings: getRankings(room),
      });
      break;
    }

    case 'reset_game': {
      if (room.hostId !== connId) return;
      room.gameStatus = 'waiting';
      room.currentQuestionIndex = -1;
      room.canAnswer = false;
      room.players.forEach(p => {
        p.score = 0;
        p.correctCount = 0;
        p.answered = false;
      });
      broadcast(room, { type: 'game_reset' });
      break;
    }

    case 'kick_player': {
      if (room.hostId !== connId) return;
      const targetId = data.playerId;
      if (targetId === connId) return;
      room.players.delete(targetId);
      broadcast(room, {
        type: 'player_kicked',
        playerId: targetId,
        playerCount: room.players.size,
      });
      break;
    }

    case 'get_room_info': {
      sendTo(conn, {
        type: 'room_info',
        roomCode: roomId,
        playerCount: room.players.size,
        questionCount: room.questions.length,
        gameStatus: room.gameStatus,
        isHost: room.hostId === connId,
      });
      break;
    }
  }
}

function getRankings(room: RoomState) {
  return Array.from(room.players.values())
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
    .slice(0, 10)
    .map((p, i) => ({
      rank: i + 1,
      id: p.id,
      name: p.name,
      score: p.score,
      correctCount: p.correctCount,
    }));
}
