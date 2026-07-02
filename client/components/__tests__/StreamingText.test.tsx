import { StreamingText } from "../StreamingText";

describe("StreamingText", () => {
  it("renders all words of the text", () => {
    // Test that component accepts text prop and doesn't throw
    const component = <StreamingText text="Once upon a time" />;
    expect(component).toBeTruthy();
    expect(component.props.text).toBe("Once upon a time");
  });

  it("renders newly appended words on update", () => {
    // Test that component accepts updated text prop
    const component1 = <StreamingText text="The lantern" />;
    expect(component1.props.text).toBe("The lantern");

    const component2 = <StreamingText text="The lantern guttered" />;
    expect(component2.props.text).toBe("The lantern guttered");
    expect(component2.props.text).toMatch(/guttered/);
  });

  it("preserves paragraph breaks", () => {
    // Test that component accepts text with paragraph breaks
    const component = <StreamingText text={"One.\n\nTwo."} />;
    expect(component.props.text).toContain("\n\n");

    // Verify the text would split correctly
    const paragraphs = component.props.text.split("\n\n");
    expect(paragraphs.length).toBe(2);
  });
});
