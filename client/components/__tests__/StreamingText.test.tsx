import { render } from "@testing-library/react-native";
import { StreamingText } from "../StreamingText";

describe("StreamingText", () => {
  it("renders all words of the text", () => {
    const { getByText } = render(<StreamingText text="Once upon a time" />);
    expect(getByText(/Once/)).toBeTruthy();
    expect(getByText(/time/)).toBeTruthy();
  });

  it("renders newly appended words on update", () => {
    const { rerender, getByText, queryByText } = render(
      <StreamingText text="The lantern" />
    );
    expect(queryByText(/guttered/)).toBeNull();
    rerender(<StreamingText text="The lantern guttered" />);
    expect(getByText(/guttered/)).toBeTruthy();
  });

  it("preserves paragraph breaks", () => {
    const { getAllByTestId } = render(<StreamingText text={"One.\n\nTwo."} />);
    expect(getAllByTestId("paragraph").length).toBe(2);
  });
});
