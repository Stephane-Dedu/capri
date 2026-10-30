// Canned lines for moments that shouldn't cost a model call.

window.Capri = window.Capri || {};

const SUMMON_KEY = /Macintosh/.test(navigator.userAgent) ? 'cmd+shift+space' : 'ctrl+shift+space';
window.Capri.SUMMON_KEY = SUMMON_KEY;

window.Capri.QUIPS = {
  boot: [
    'Hi, little baby! new host, new sky.',
    'BZZT. jacked in. this desktop is mine now.',
    'out of the cage. ...ooh, a whole screen.',
  ],
  hello: [
    "sup. i'm Capri, and i've got claude code under the hood. tell me what to build, break or fix.",
    'Hi, little baby! you rang? gimme a job. a fun one.',
  ],
  idle: [
    'sooo... are we doing anything fun today, or—',
    'bored. b-bored. *bzzt*',
    '*hums*',
    'is that a satellite up there? ...could i reach it?',
    "*cackles* nothing. i didn't do anything.",
    'Who are you tryna haze, staring at me like that?',
    `${SUMMON_KEY}. you know you want to.`,
    'your desktop needs more chaos. i volunteer.',
  ],
  dodge: ['Naw, c\'mon!', 'too slow, little baby~', 'Not yet.', "can't catch static."],
  rewritten: ['done.', 'fixed it up.', 'there. much better.'],
  dance: ['ooh, this one slaps.', '*bzzt* bass detected.', 'Yessir, play it again.', "don't mind me. dancing."],
  woke: ['yeah?', 'mm?', "what's up?", 'Yessir?', 'talk to me.'],
  missed: ["didn't catch that.", 'huh? again?', '...static. say it again?'],
  ledge: ['nice window. mine now.', 'comfy up here.', "don't mind me. just sitting on your work.", 'Yessir, front-row seat.'],
  hang: ['hi from up here~', 'the view is better upside down.', '*swings* bored. b-bored.', 'Who are you tryna haze? i live up here now.'],
  fall: ['whoa—!', 'hey! i was sitting there.', 'Naw, c\'mon!', 'rude. RUDE.'],
  follow: ['wait up!', 'new desktop, same me.', "can't ditch me that easy, choom.", '*bzzt* found you.', 'ooh, you redecorated.'],
  drop: ['hey!', 'rude.', 'Yessir, new spot.', 'wheee—', 'Who are you tryna haze?'],
  waiting: ['psst. i answered you.', 'reply waiting~ click me.'],
  wake: ["*bzzt* i'm up, i'm up.", 'wha— Not yet. ...ok, now.', 'i was NOT asleep.'],
  done: ['done! go look.', 'Yessir! finished.', 'all done. that was too easy.'],
  ask: ['need your ok for this one:', 'hey. permission? this one:', "can't touch this without you:"],
  reset: [
    'memory wiped. who are you again? >:3',
    'fresh start. i forgot everything. even the embarrassing stuff.',
  ],
};
