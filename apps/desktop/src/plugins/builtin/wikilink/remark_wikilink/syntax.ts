import type { Code, Effects, Extension, State } from "micromark-util-types";

import { codes } from "micromark-util-symbol";

function isEofOrLineEnding(code: Code): boolean {
  return (
    code === codes.eof ||
    code === codes.carriageReturn ||
    code === codes.lineFeed ||
    code === codes.carriageReturnLineFeed
  );
}

function isOpenBracket(code: Code): boolean {
  return code === codes.leftSquareBracket;
}

function isCloseBracket(code: Code): boolean {
  return code === codes.rightSquareBracket;
}

export function syntax(): Extension {
  return {
    text: {
      [codes.leftSquareBracket]: {
        name: "wikilink",
        tokenize: tokenizer,
      },
    },
  };
}

function tokenizer(effects: Effects, ok: State, nok: State): State {
  return start;

  function start(code: Code): State | undefined {
    if (!isOpenBracket(code)) return nok(code);

    effects.enter("wikilink");
    effects.enter("wikilinkMarkerOpen");
    effects.consume(code);

    return openSecondBracket;
  }

  function openSecondBracket(code: Code): State | undefined {
    if (!isOpenBracket(code)) return nok(code);

    effects.consume(code);
    effects.exit("wikilinkMarkerOpen");

    return targetStart;
  }

  function targetStart(code: Code): State | undefined {
    if (isEofOrLineEnding(code) || isCloseBracket(code) || code === codes.verticalBar) {
      return nok(code);
    }

    effects.enter("wikilinkTarget");
    effects.enter("wikilinkData");

    return targetInside(code);
  }

  function targetInside(code: Code): State | undefined {
    if (isEofOrLineEnding(code)) {
      return nok(code);
    }

    if (code === codes.verticalBar) {
      effects.exit("wikilinkData");
      effects.exit("wikilinkTarget");

      effects.enter("wikilinkSeparator");
      effects.consume(code);
      effects.exit("wikilinkSeparator");

      return aliasStart;
    }

    if (isCloseBracket(code)) {
      effects.exit("wikilinkData");
      effects.exit("wikilinkTarget");

      return closeFirstBracket(code);
    }

    effects.consume(code);
    return targetInside;
  }

  function aliasStart(code: Code): State | undefined {
    if (isEofOrLineEnding(code) || isCloseBracket(code)) {
      return nok(code);
    }

    effects.enter("wikilinkAlias");
    effects.enter("wikilinkAliasData");

    return aliasInside(code);
  }

  function aliasInside(code: Code): State | undefined {
    if (isEofOrLineEnding(code)) {
      return nok(code);
    }

    if (isCloseBracket(code)) {
      effects.exit("wikilinkAliasData");
      effects.exit("wikilinkAlias");

      return closeFirstBracket(code);
    }

    effects.consume(code);
    return aliasInside;
  }

  function closeFirstBracket(code: Code): State | undefined {
    if (!isCloseBracket(code)) return nok(code);

    effects.enter("wikilinkMarkerClose");
    effects.consume(code);

    return closeSecondBracket;
  }

  function closeSecondBracket(code: Code): State | undefined {
    if (!isCloseBracket(code)) return nok(code);

    effects.consume(code);
    effects.exit("wikilinkMarkerClose");
    effects.exit("wikilink");

    return ok;
  }
}
