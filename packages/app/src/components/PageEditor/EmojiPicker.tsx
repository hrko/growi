import React, {
  FC, useRef, useEffect, useState,
} from 'react';
import { Picker } from 'emoji-mart';
import EmojiPickerHelper, { getEmojiTranslation } from './EmojiPickerHelper';

type Props = {
  close: () => void,
  emojiSearchText: string,
  editor: any
}

const EmojiPicker: FC<Props> = (props: Props) => {

  const { close, emojiSearchText, editor } = props;

  const emojiPickerContainer = useRef<HTMLDivElement>(null);
  const [emojiPickerHeight, setEmojiPickerHeight] = useState(0);
  const [style, setStyle] = useState({});
  const emojiPickerHelper = new EmojiPickerHelper(editor);

  useEffect(() => {
    if (emojiPickerContainer.current) {
      setEmojiPickerHeight(emojiPickerContainer.current.getBoundingClientRect().height);
    }
    setStyle(emojiPickerHelper.getCursorCoords(emojiPickerHeight));
    if (emojiSearchText != null) {
      // Get input element of emoji picker search
      const input = document.querySelector('[id^="emoji-mart-search"]') as HTMLInputElement;
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      // Set value to input of emoji picker search and trigger the search
      valueSetter?.call(input, emojiSearchText);
      const event = new Event('input', { bubbles: true });
      input.dispatchEvent(event);
    }

    function handleClickOutside(event) {
      if (emojiPickerContainer.current && !emojiPickerContainer.current.contains(event.target)) {
        close();
        setStyle({});
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      // Unbind the event listener on clean up
      document.removeEventListener('mousedown', handleClickOutside);
    };


  }, [emojiPickerContainer, close, emojiSearchText, emojiPickerHeight]);

  const selectEmoji = (emoji) => {
    if (emojiSearchText !== null) {
      emojiPickerHelper.addEmojiOnSearch(emoji);
    }
    else {
      emojiPickerHelper.addEmoji(emoji);
    }
  };

  const translation = getEmojiTranslation();
  return Object.keys(style).length !== 0 ? (
    <div className="overlay">
      <div ref={emojiPickerContainer} style={style}>
        <Picker set="apple" autoFocus onSelect={selectEmoji} i18n={translation} title={translation.title} />
      </div>
    </div>
  ) : <></>;
};

export default EmojiPicker;
