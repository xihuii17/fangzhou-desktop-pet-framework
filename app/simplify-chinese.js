ObjC.import('Foundation');
ObjC.import('CoreFoundation');

function simplify(text) {
  const value = $.NSMutableString.stringWithString(String(text || ''));
  $.CFStringTransform(value, null, $('Traditional-Simplified'), false);
  return ObjC.unwrap(value);
}

function run(argv) {
  try {
    const lines = JSON.parse(argv[0] || '[]');
    return JSON.stringify(lines.map(simplify));
  } catch (_error) {
    return '[]';
  }
}
